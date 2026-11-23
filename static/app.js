const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("ko-KR");
const clock = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "long", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const colors = ["#ed737e", "#679bff", "#f3cd58", "#b896ff", "#f2a875"];

let socket;
let snapshot;
let article;
let paused = false;
let pending;
let busy = false;

async function api(path, body, method = "GET") {
  const response = await fetch(path, {
    method,
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || "요청을 처리할 수 없어요.");
  return result;
}

function render(frame) {
  snapshot = frame;
  const metrics = byId("metrics");
  metrics.classList.remove("is-updating");
  // Flush the class removal so the animation restarts for each displayed frame.
  void metrics.offsetWidth;
  metrics.classList.add("is-updating");
  const ranked = [...frame.candidates].sort((a, b) => b.votes - a.votes);
  const total = ranked.reduce((sum, candidate) => sum + candidate.votes, 0);
  const label = frame.record_type === "reported" ? "당시 보도 집계" : "시연용 재구성";
  byId("clock").textContent = `${clock.format(new Date(frame.collected_at))} KST · ${label}`;
  byId("progress").textContent = frame.counted_rate + "%";
  byId("total").textContent = number.format(total);
  byId("leader").textContent = ranked[0].candidate_name;
  byId("gap").textContent = number.format(ranked[0].votes - ranked[1].votes);
  byId("meta").textContent = `${frame.region} · ${frame.step_id}/12단계 · ${label}`;
  byId("source").href = frame.source_url;
  byId("source").textContent = frame.source + " ↗";
  byId("ticker").textContent = `${label} · ${frame.counted_rate === 100 ? "개표 완료" : "개표 진행 " + frame.counted_rate + "%"} · ${ranked[0].candidate_name} ${ranked[0].vote_rate.toFixed(2)}%`;

  for (const [index, candidate] of ranked.entries()) {
    let row = byId(candidate.candidate_id);
    if (!row) {
      row = document.createElement("div");
      row.className = "bar-row";
      row.id = candidate.candidate_id;
      row.innerHTML = '<span><b></b><small></small></span><strong></strong><div class="track"><div class="fill"></div></div>';
    }
    row.querySelector("b").textContent = candidate.candidate_name;
    row.querySelector("small").textContent = candidate.party;
    row.querySelector("strong").textContent = `${number.format(candidate.votes)}표 · ${candidate.vote_rate.toFixed(2)}%`;
    const fill = row.querySelector(".fill");
    fill.style.background = colors[Number(candidate.candidate_id.split("-").pop()) - 1];
    fill.style.width = candidate.vote_rate + "%";
    if (byId("bars").children[index] !== row) {
      byId("bars").insertBefore(row, byId("bars").children[index] || null);
    }
  }
  updateActions();
}

function updateActions() {
  byId("draft").disabled = busy || !snapshot;
  byId("save").disabled = busy || !article || !["draft", "fact_checked"].includes(article.status);
  byId("article-title-input").disabled = busy || !article || !["draft", "fact_checked"].includes(article.status);
  byId("article-body-input").disabled = busy || !article || !["draft", "fact_checked"].includes(article.status);
  byId("check").disabled = busy || article?.status !== "draft";
  byId("review").disabled = busy || article?.status !== "fact_checked";
  byId("approve").disabled = busy || article?.status !== "human_reviewed";
}

function connect() {
  socket?.close();
  paused = false;
  pending = undefined;
  byId("pause").textContent = "일시정지";
  byId("pause").disabled = false;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const connection = new WebSocket(`${protocol}//${location.host}/ws/replay`);
  socket = connection;
  connection.onmessage = (event) => {
    if (socket !== connection) return;
    const frame = JSON.parse(event.data);
    if (paused) pending = frame;
    else render(frame);
    if (frame.step_id === 1 && !article && !busy) createDraft(frame);
  };
  connection.onclose = () => {
    if (socket !== connection) return;
    if (!paused) byId("pause").disabled = true;
    if ((pending || snapshot)?.step_id !== 12) {
      byId("ticker").textContent = "재생 연결이 종료됐어요. 개표 재생을 눌러 다시 시작해 주세요.";
    }
  };
}

byId("start").onclick = connect;
byId("pause").onclick = () => {
  paused = !paused;
  byId("pause").textContent = paused ? "최신 집계로 돌아가기" : "일시정지";
  if (!paused && pending) {
    render(pending);
    pending = undefined;
  }
  if (!paused && socket.readyState === WebSocket.CLOSED) byId("pause").disabled = true;
};

const states = {
  draft: "초안",
  fact_checked: "팩트체크 통과",
  human_reviewed: "사람 검토 완료",
  approved: "편집장 승인 완료",
  rejected: "반려",
};

async function editorialAction(operation) {
  if (busy) return;
  busy = true;
  updateActions();
  try {
    const result = await operation();
    article = result.article || result;
    showArticle(article);
    byId("status").textContent = result.result?.reason || states[article.status];
    if (result.result && result.result.status !== "pass") {
      byId("status").textContent += ` (${result.result.status})`;
    }
    await Promise.all([refreshArticleList(), refreshAudit()]);
  } catch (error) {
    byId("status").textContent = error.message;
  } finally {
    busy = false;
    updateActions();
  }
}

function createDraft(frame, mode = "template") {
  return editorialAction(() => api("/api/articles", { snapshot: frame, generation_mode: mode }, "POST"));
}

byId("draft").onclick = () => createDraft(snapshot, byId("generation-mode").value);
byId("save").onclick = () => editorialAction(() =>
  api(`/api/articles/${article.article_id}`, {
    title: byId("article-title-input").value,
    body: byId("article-body-input").value,
  }, "PUT"));
byId("check").onclick = () => editorialAction(() =>
  api(`/api/articles/${article.article_id}/fact-check`, undefined, "POST"));

for (const [button, endpoint] of [["review", "human-review"], ["approve", "approve"]]) {
  byId(button).onclick = () => {
    const reviewer = byId("reviewer").value.trim();
    if (!reviewer) {
      byId("status").textContent = "검토자 이름을 입력해 주세요.";
      byId("reviewer").focus();
      return;
    }
    editorialAction(() => api(`/api/articles/${article.article_id}/${endpoint}`, { reviewer }, "POST"));
  };
}

byId("search-form").onsubmit = async (event) => {
  event.preventDefault();
  const target = byId("evidence");
  try {
    const { results } = await api("/api/rag/search?replay=true&q=" + encodeURIComponent(byId("query").value));
    target.replaceChildren();
    if (!results.length) target.textContent = "검색 결과가 없어요.";
    for (const result of results) {
      const card = document.createElement("article");
      const link = document.createElement("a");
      link.href = result.source_url;
      link.textContent = `[${result.evidence_id}] ${result.title}`;
      const summary = document.createElement("p");
      summary.textContent = result.content;
      card.append(link, summary);
      target.append(card);
    }
  } catch (error) {
    target.textContent = error.message;
  }
};


function showArticle(next) {
  article = next;
  byId("article-title-input").value = next.title;
  byId("article-body-input").value = next.body;
  const ids = (next.evidence || []).map(item => item.evidence_id).join(", ");
  byId("article-evidence").textContent = ids ? `연결 근거 ID: ${ids}` : "연결된 근거 없음";
  updateActions();
}

async function refreshArticleList() {
  const target = byId("article-list");
  const status = byId("article-filter").value;
  try {
    const query = new URLSearchParams({limit: "50"});
    if (status) query.set("status", status);
    const data = await api(`/api/articles?${query}`);
    target.replaceChildren();
    if (!data.articles.length) { target.textContent = "저장된 기사가 없습니다."; return; }
    for (const item of data.articles) {
      const button = document.createElement("button");
      button.type = "button";
      button.classList.toggle("is-current", article?.article_id === item.article_id);
      const title = document.createElement("strong");
      title.textContent = item.title;
      const details = document.createElement("small");
      details.textContent = `${states[item.status] || item.status} · ${item.snapshot.step_id}단계 · ${new Date(item.updated_at).toLocaleString("ko-KR")}`;
      button.append(title, details);
      button.onclick = async () => {
        if (busy) return;
        try {
          showArticle(await api(`/api/articles/${item.article_id}`));
          byId("status").textContent = states[article.status] || article.status;
          await Promise.all([refreshAudit(), refreshArticleList()]);
        } catch (error) { byId("status").textContent = error.message; }
      };
      target.append(button);
    }
  } catch (error) { target.textContent = error.message; }
}

async function refreshAudit() {
  const target = byId("article-audit");
  if (!article) { target.textContent = "기사를 선택해 주세요."; return; }
  try {
    const logs = await api(`/api/articles/${article.article_id}/audit`);
    target.replaceChildren();
    if (!logs.length) { target.textContent = "기록이 없습니다."; return; }
    for (const item of logs) {
      const row = document.createElement("div");
      row.textContent = `${new Date(item.created_at).toLocaleString("ko-KR")} · ${item.action} · ${item.actor}`;
      target.append(row);
    }
  } catch (error) { target.textContent = error.message; }
}

byId("refresh-articles").onclick = refreshArticleList;
byId("article-filter").onchange = refreshArticleList;
byId("rag-answer").onclick = async () => {
  const target = byId("answer");
  const question = byId("query").value.trim();
  if (question.length < 2) { target.textContent = "두 글자 이상 질문해 주세요."; return; }
  target.textContent = "근거 자료를 확인하는 중입니다…";
  try {
    const data = await api(`/api/rag/answer?replay=true&q=${encodeURIComponent(question)}`);
    target.replaceChildren();
    const answer = document.createElement("div");
    answer.textContent = data.answer || "답변이 없습니다.";
    target.append(answer);
    for (const evidence of data.evidence || []) {
      if (!evidence.source_url) continue;
      const link = document.createElement("a");
      link.href = evidence.source_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `[${evidence.evidence_id}] ${evidence.title || evidence.source || "근거 자료"}`;
      target.append(link);
    }
  } catch (error) { target.textContent = error.message; }
};

refreshArticleList();


// traffic-reference-ui-v1: same tabbed newsroom structure as the traffic reference.
const workspaceViews = new Set(["election", "draft", "review", "rag", "library"]);
function openWorkspaceView(name) {
  if (!workspaceViews.has(name)) return;
  document.querySelectorAll(".workspace-nav [data-view]").forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("main .view").forEach((panel) => {
    const active = panel.id === `view-${name}`;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
}
document.querySelectorAll("[data-view], [data-go]").forEach((button) => {
  button.addEventListener("click", () => openWorkspaceView(button.dataset.view || button.dataset.go));
});
const syncWorkspaceCurrent = () => {
  const name = article ? `${article.title}\n\n상태: ${states[article.status] || article.status}\n${article.snapshot.step_id}단계` : "선택된 기사가 없습니다.";
  byId("review-current-status").textContent = name;
  byId("library-preview").textContent = name;
};
// The existing workflow owns article state; read it when panels are opened.
document.querySelectorAll("[data-view], [data-go]").forEach((button) => {
  button.addEventListener("click", syncWorkspaceCurrent);
});
const articleListNode = byId("article-list");
articleListNode.addEventListener("click", (e) => {
  if (e.target.closest("button")) {
    queueMicrotask(() => {syncWorkspaceCurrent();openWorkspaceView("draft");});
  }
});
const originalShowArticle = showArticle;
showArticle = function(next) { originalShowArticle(next); syncWorkspaceCurrent(); };


// election-floating-v2: floating newsroom and source-grounded RAG popup.
(() => {
  const launcher = document.getElementById("float-chat");
  const panel = document.getElementById("floating-rag-panel");
  const input = document.getElementById("floating-rag-input");
  const messages = document.getElementById("floating-rag-messages");
  const form = document.getElementById("floating-rag-form");
  const send = form.querySelector('button[type="submit"]');
  const setOpen = (open) => {
    panel.hidden = !open;
    launcher.setAttribute("aria-expanded", String(open));
    if (open) input.focus();
  };
  launcher.addEventListener("click", () => setOpen(panel.hidden));
  document.getElementById("floating-rag-close").addEventListener("click", () => {setOpen(false);launcher.focus();});
  document.getElementById("float-newsroom").addEventListener("click", () => {openWorkspaceView("draft");setOpen(false);window.scrollTo({top:0,behavior:"smooth"});});
  document.addEventListener("keydown", (event) => {if (event.key === "Escape" && !panel.hidden) setOpen(false);});

  const addBubble = (value, role) => {
    const div = document.createElement("div");
    div.className = "chat-bubble " + role;
    div.textContent = value;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (question.length < 2 || send.disabled) return;
    const intro = messages.querySelector(".rag-empty");if (intro) intro.remove();
    addBubble(question, "user");input.value="";send.disabled=true;
    const responseBubble = addBubble("근거를 확인하고 있습니다…", "assistant");
    try {
      const data = await api(`/api/rag/answer?replay=true&q=${encodeURIComponent(question)}`);
      responseBubble.textContent = data.answer || "답변을 확인할 수 없습니다.";
      const allowed = new Set(data.evidence_ids || []);
      const used = (data.evidence || []).filter(item => allowed.has(item.evidence_id));
      if (used.length) {
        const sources = document.createElement("div");sources.className="chat-sources";
        for (const ev of used) {
          const link=document.createElement("a");link.textContent=`[${ev.evidence_id}] ${ev.title || ev.source}`;
          if(ev.source_url){link.href=ev.source_url;link.target="_blank";link.rel="noopener noreferrer";}
          sources.appendChild(link);
        }
        messages.appendChild(sources);
      }
    } catch(error) {responseBubble.textContent = error.message;}
    finally {send.disabled=false;messages.scrollTop=messages.scrollHeight;}
  });
})();

// From the existing 12 snapshots only: no invented district/turnout data.
(() => {
  const ns = "http://www.w3.org/2000/svg";
  let frames = [];
  let activeStep = 0;
  const svgNode = (name, attrs, text) => {
    const node=document.createElementNS(ns,name);
    for(const [k,v] of Object.entries(attrs)) node.setAttribute(k,String(v));
    if(text !== undefined) node.textContent=String(text);
    return node;
  };
  const plot = (target, series, min, max, labels, format, selected) => {
    const container=document.getElementById(target);container.replaceChildren();
    const width=520,height=205,L=54,R=13,T=18,B=31;
    const x=i=>L+(width-L-R)*(i/Math.max(1,frames.length-1));
    const y=v=>T+(height-T-B)*(1-(v-min)/Math.max(1,max-min));
    const svg=svgNode("svg",{viewBox:`0 0 ${width} ${height}`,role:"img","aria-label":labels.join(", ")+" 12단계 변화"});
    for(let k=0;k<=4;k++){
      const v=min+(max-min)*k/4, yy=y(v);
      svg.appendChild(svgNode("line",{x1:L,y1:yy,x2:width-R,y2:yy,stroke:"#dae6e4","stroke-dasharray":"3 4"}));
      svg.appendChild(svgNode("text",{x:L-6,y:yy+4,"text-anchor":"end",fill:"#71828e","font-size":10},format(v)));
    }
    series.forEach((points,idx)=>{
      svg.appendChild(svgNode("polyline",{points:points.map((v,i)=>`${x(i)},${y(v)}`).join(" "),stroke:["#176b5c","#3988b7"][idx],"stroke-width":2.7,fill:"none","stroke-linejoin":"round","stroke-linecap":"round"}));
      if(selected>=1 && selected<=points.length) svg.appendChild(svgNode("circle",{cx:x(selected-1),cy:y(points[selected-1]),r:4,fill:["#176b5c","#3988b7"][idx],stroke:"#fff","stroke-width":1.5}));
    });
    [1,4,8,12].forEach(k=>svg.appendChild(svgNode("text",{x:x(k-1),y:height-8,"text-anchor":"middle",fill:"#71828e","font-size":11},`${k}단계`)));
    container.append(svg);
    const legend=document.createElement("div");legend.className="trend-legend";
    legend.style.cssText="font-size:11px;color:#526b6b;display:flex;gap:16px;justify-content:center;margin-top:5px";
    labels.forEach((label,idx)=>{const span=document.createElement("span");span.textContent=`● ${label}`;span.style.color=["#176b5c","#3988b7"][idx];legend.append(span);});
    container.append(legend);
  };
  const update=() => {
    if(!frames.length)return;
    const two=frames.map(f=>f.candidates.slice(0,2));
    const first=two.map(pair=>pair[0].vote_rate),second=two.map(pair=>pair[1].vote_rate);
    const low=Math.floor((Math.min(...first,...second)-1)/2)*2;
    const high=Math.ceil((Math.max(...first,...second)+1)/2)*2;
    plot("rate-trend",[first,second],low,high,[two[0][0].candidate_name,two[0][1].candidate_name],v=>v.toFixed(0)+"%",activeStep);
    const gap=two.map(pair=>pair[0].votes-pair[1].votes);
    const abs=Math.ceil(Math.max(...gap.map(Math.abs),1000)/10000)*10000;
    plot("gap-trend",[gap],-abs,abs,[`${two[0][0].candidate_name} − ${two[0][1].candidate_name}`],v=>Math.round(v/10000)+"만",activeStep);
  };
  const originalRender=render;
  render=function(frame){originalRender(frame);activeStep=frame.step_id;update();};
  api("/api/replay").then(data=>{if(!Array.isArray(data)||data.length!==12)throw Error("12단계 데이터 형식이 다릅니다.");frames=data;update();}).catch(error=>{document.getElementById("rate-trend").textContent="개표 추이 로드 실패: "+error.message;document.getElementById("gap-trend").textContent="데이터를 불러올 수 없습니다.";});
})();
