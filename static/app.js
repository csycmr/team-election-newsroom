const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("ko-KR");
const clock = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "long", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const colors = ["#ed737e", "#679bff", "#f3cd58", "#b896ff", "#f2a875"];

const breakingEvents = new Set([
  "투표용지 부족으로 잠실7동 제2투표소 투표 연장",
  "오세훈 역전",
  "잠실7동 제2투표소 투표함 2개 이송",
]);

const ticker = byId("ticker");
const tickerCopies = Array.from({ length: 2 }, () => {
  const copy = document.createElement("span");
  copy.setAttribute("aria-hidden", "true");
  ticker.parentElement.append(copy);
  return copy;
});

const initialTickerHeadline = ticker.textContent;
const tickerRows = [ticker, ...tickerCopies].map((row) => {
  const headline = document.createElement("span");
  headline.className = "ticker-headline";
  headline.textContent = initialTickerHeadline;
  const stage = document.createElement("small");
  stage.className = "ticker-stage";
  stage.textContent = "개표 재생 대기";
  row.replaceChildren(headline, stage);
  return { headline, stage };
});

function setTickerText(message, stageText) {
  for (const { headline, stage } of tickerRows) {
    headline.textContent = message;
    if (stageText !== undefined) stage.textContent = stageText;
  }
}

let socket;
let snapshot;
let displayedFrame;
let article;
let resumeDelay = null;
let busy = false;
let replayFrames = [];
let replayDeadline = 0;

function publishReplayState(kind, frame) {
  const next = frame && replayFrames[frame.step_id];
  document.dispatchEvent(new CustomEvent("count-replay", {
    detail: { kind, frame, next, deadline: replayDeadline },
  }));
}

async function api(path, body, method = "GET") {
  const mutate = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  const requestOnce = async (token) => {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (mutate && token) headers["X-Newsroom-Token"] = token;
    const response = await fetch(path, {
      method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    return { response, result };
  };
  let token = sessionStorage.getItem("newsroom-team-token") || "";
  let { response, result } = await requestOnce(token);
  if (mutate && response.status === 401 && result.detail === "TEAM_AUTH_REQUIRED") {
    token = window.prompt("기사 작성·승인용 팀원 암호를 입력하세요.") || "";
    if (!token) throw new Error("팀원 인증이 취소되었습니다.");
    ({ response, result } = await requestOnce(token));
    if (response.ok) sessionStorage.setItem("newsroom-team-token", token);
    else sessionStorage.removeItem("newsroom-team-token");
  }
  if (!response.ok) throw new Error(result.detail || "요청을 처리할 수 없어요.");
  return result;
}

function render(frame) {
  displayedFrame = frame;
  snapshot = frame.article_snapshot;
  const lastCount = frame.counted_rate === null
    ? replayFrames.slice(0, frame.step_id - 1).findLast((entry) => entry.counted_rate !== null)
    : frame;
  const ranked = [...(lastCount?.candidates ?? [])].sort((a, b) => b.votes - a.votes);
  const byCandidate = new Map(ranked.map((candidate) => [candidate.candidate_id, candidate]));
  const roster = replayFrames.at(-1).candidates;
  const rows = [...ranked, ...roster.filter((candidate) => !byCandidate.has(candidate.candidate_id))
    .map((candidate) => ({ ...candidate, votes: null, vote_rate: null }))];
  const total = lastCount?.counted_valid_votes ?? null;

  const metrics = byId("metrics");
  metrics.classList.remove("is-updating");
  void metrics.offsetWidth;
  metrics.classList.add("is-updating");
  const timestamp = clock.format(new Date(frame.timestamp_kst));
  const approximate = frame.time_basis === "approximate" ? "쯤" : "";
  const isSimulation = frame.time_basis === "simulated";
  const eventTitle = isSimulation ? "개표 진행" : frame.event;
  byId("clock").textContent = `${timestamp}${approximate} KST · ${eventTitle}`;
  byId("progress").textContent = lastCount ? lastCount.counted_rate_pct + "%" : "—";
  byId("total").textContent = total === null ? "—" : number.format(total);
  const totalMeta = byId("total-meta");
  totalMeta.textContent = lastCount?.counted_valid_votes_basis === "simulation_interpolation"
    ? "시연 데이터 기반 추정"
    : lastCount?.counted_valid_votes_basis === "simulated" ? "시연 수치" : "";
  totalMeta.hidden = !totalMeta.textContent;
  byId("leader").textContent = ranked[0]?.candidate_name ?? "—";
  byId("gap").textContent = ranked.length >= 2 ? number.format(ranked[0].votes - ranked[1].votes) : "—";

  const coverage = ranked.some(candidate => candidate.is_simulated)
    ? " · 주요 후보 2명 보도 수치, 나머지 3명 시연 추정"
    : ranked.length > 0 && ranked.length < roster.length ? " · 주요 후보 2명 보도 수치" : "";
  const retained = lastCount && lastCount !== frame
    ? ` · 직전 집계 ${clock.format(new Date(lastCount.timestamp_kst))} 기준`
    : "";
  byId("meta").textContent = `${frame.step_id}/${replayFrames.length}개 시점${retained}${coverage}${lastCount?.time_basis === "simulated" ? " · 시연용 재구성" : ""}`;
  byId("source").href = lastCount?.additional_source_url || lastCount?.source_url || frame.source_url;
  byId("source").textContent = lastCount?.additional_source_url ? "최종 집계표 ↗" : `${(lastCount || frame).source_name} ↗`;
  const breaking = breakingEvents.has(frame.event) && socket?.readyState === WebSocket.OPEN;
  byId("ticker-alert-light").hidden = !breaking;
  const headline = breaking || frame.counted_rate === null
    ? eventTitle
    : `${eventTitle} · 개표율 ${frame.counted_rate_pct}%`;
  const stageText = `${frame.step_id}/${replayFrames.length}단계 · ${timestamp} KST · ${eventTitle}`;
  setTickerText(headline, stageText);
  const tickerMeta = byId("ticker-meta");
  tickerMeta.textContent = isSimulation ? "시연용 재구성" : frame.counted_rate === null ? "보도 기록" : "보도 집계";
  tickerMeta.hidden = false;

  renderCandidateBars(rows, !lastCount);
  updateActions();
}

function renderCandidateBars(candidates, waiting = false) {
  for (const [index, candidate] of candidates.entries()) {
    let row = byId(candidate.candidate_id);
    if (!row) {
      row = document.createElement("div");
      row.className = "bar-row";
      row.id = candidate.candidate_id;
      row.innerHTML = '<span><b></b><small></small></span><strong></strong><div class="track"><div class="fill"></div></div>';
    }
    row.querySelector("b").textContent = candidate.candidate_name;
    row.querySelector("small").textContent = candidate.party;
    const value = row.querySelector("strong");
    value.classList.toggle("is-missing", candidate.votes === null);
    value.textContent = waiting ? "" : candidate.votes === null ? "보도 수치 없음" : `${number.format(candidate.votes)}표 · ${candidate.vote_rate.toFixed(2)}%`;
    if (!waiting && candidate.is_simulated) {
      const sourceNote = document.createElement("small");
      sourceNote.className = "candidate-estimate";
      sourceNote.textContent = "시연 추정";
      value.append(" ", sourceNote);
    }
    const fill = row.querySelector(".fill");
    fill.style.background = colors[Number(candidate.candidate_id.split("-").pop()) - 1];
    fill.style.width = waiting || candidate.vote_rate === null ? "0%" : candidate.vote_rate + "%";
    if (byId("bars").children[index] !== row) {
      byId("bars").insertBefore(row, byId("bars").children[index] || null);
    }
  }
}

function updateActions() {
  byId("draft").disabled = busy || !snapshot;
  byId("replay-draft").disabled = busy || !snapshot;
  byId("pledge-draft").disabled = busy;
  byId("editor-article-select").disabled = busy || byId("editor-article-select").options.length < 2;
  byId("save").disabled = busy || !article || !["draft", "fact_checked"].includes(article.status);
  byId("article-title-input").disabled = busy || !article || !["draft", "fact_checked"].includes(article.status);
  byId("article-body-input").disabled = busy || !article || !["draft", "fact_checked"].includes(article.status);
  byId("check").disabled = busy || article?.status !== "draft";
  byId("review").disabled = busy || article?.status !== "fact_checked";
  byId("approve").disabled = busy || article?.status !== "human_reviewed";
  byId("reject").disabled = busy || article?.status !== "human_reviewed";
}

function disconnectReplay() {
  const connection = socket;
  socket = undefined;
  connection?.close();
}

function connectReplay(startStep, delayMs) {
  byId("start").textContent = "일시 정지";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ start_step: startStep, delay_ms: delayMs });
  const connection = new WebSocket(`${protocol}//${location.host}/ws/count-timeline?${query}`);
  socket = connection;
  connection.onmessage = (event) => {
    if (socket !== connection) return;
    const frame = JSON.parse(event.data);
    replayDeadline = performance.now() + 5000;
    render(frame);
    publishReplayState("frame", frame);
  };
  connection.onclose = () => {
    if (socket !== connection) return;
    socket = undefined;
    byId("start").textContent = "개표 재생";
    byId("ticker-alert-light").hidden = true;
    publishReplayState("stop");
    if (displayedFrame?.step_id !== replayFrames.length) {
      byId("ticker-meta").hidden = true;
      setTickerText("재생 연결이 종료됐어요. 개표 재생을 눌러 다시 시작해 주세요.");
    }
  };
}

function restartReplay() {
  disconnectReplay();
  resumeDelay = null;
  replayDeadline = performance.now();
  render(replayFrames[0]);
  publishReplayState("start");
  connectReplay(1, 0);
}

byId("start").onclick = () => {
  if (socket) {
    resumeDelay = Math.max(0, Math.min(5000, Math.ceil(replayDeadline - performance.now())));
    disconnectReplay();
    byId("start").textContent = "개표 재생";
    publishReplayState("pause");
    return;
  }
  if (resumeDelay === null || displayedFrame.step_id >= replayFrames.length) {
    restartReplay();
    return;
  }
  const delay = resumeDelay;
  resumeDelay = null;
  replayDeadline = performance.now() + delay;
  connectReplay(displayedFrame.step_id + 1, delay);
  publishReplayState("frame", displayedFrame);
};

byId("restart").onclick = restartReplay;

const states = {
  draft: "초안",
  fact_checked: "팩트체크 통과",
  human_reviewed: "사람 검토 완료",
  approved: "편집장 승인 완료",
  rejected: "반려",
};

async function editorialAction(operation, feedbackId = "status") {
  if (busy) return;
  const feedback = byId(feedbackId);
  if (feedbackId !== "status") byId("status").textContent = "";
  busy = true;
  updateActions();
  try {
    const result = await operation();
    showArticle(result.article || result);
    feedback.textContent = result.result?.reason || states[article.status];
    if (result.result && result.result.status !== "pass") {
      feedback.textContent += ` (${result.result.status})`;
    }
    await Promise.all([refreshEditorArticles(), refreshArchive(), refreshAudit()]);
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    busy = false;
    updateActions();
  }
}

function createDraft(frame, mode = "template") {
  return editorialAction(() => api("/api/articles", { snapshot: frame, generation_mode: mode }, "POST"));
}

byId("pledge-draft").onclick = () => {
  const candidate = byId("pledge-candidate").value;
  const query = `서울시장 ${candidate} 공약`;
  editorialAction(() => api("/api/articles/from-pledges", { query }, "POST"));
};

function draftCurrentStep() {
  const selectedSnapshot = snapshot;
  if (!selectedSnapshot || busy) return;
  openWorkspaceView("draft");
  byId("status").textContent = `${selectedSnapshot.step_id}단계 초안 작성 중…`;
  createDraft(selectedSnapshot, byId("generation-mode").value);
}

byId("draft").onclick = draftCurrentStep;
byId("replay-draft").onclick = draftCurrentStep;
byId("save").onclick = () => editorialAction(() =>
  api(`/api/articles/${article.article_id}`, {
    title: byId("article-title-input").value,
    body: byId("article-body-input").value,
  }, "PUT"));
byId("check").onclick = () => editorialAction(() =>
  api(`/api/articles/${article.article_id}/fact-check`, undefined, "POST"), "factcheck-status");

for (const [button, endpoint] of [["review", "human-review"], ["approve", "approve"], ["reject", "reject"]]) {
  byId(button).onclick = () => {
    const feedbackId = button === "review" ? "human-review-status" : "status";
    const reviewer = byId("reviewer").value.trim();
    if (!reviewer) {
      byId(feedbackId).textContent = "검토자 이름을 입력해 주세요.";
      byId("reviewer").focus();
      return;
    }
    editorialAction(() => api(`/api/articles/${article.article_id}/${endpoint}`, { reviewer }, "POST"), feedbackId);
  };
}

function showArticle(next) {
  if (article?.article_id !== next.article_id || next.status === "draft") {
    byId("factcheck-status").textContent = "";
    byId("human-review-status").textContent = "";
  }
  article = next;
  byId("article-title-input").value = next.title;
  byId("article-body-input").value = next.body;
  const ids = (next.evidence || []).map(item => item.evidence_id).join(", ");
  byId("article-evidence").textContent = ids ? `연결 근거 ID: ${ids}` : "연결된 근거 없음";
  updateActions();
}

let editorListRequest = 0;
let archiveRequest = 0;
let archiveArticleId = null;

async function refreshEditorArticles() {
  const request = ++editorListRequest;
  const target = byId("editor-article-select");
  const status = byId("article-filter").value;
  const query = new URLSearchParams({ limit: "100" });
  if (status) query.set("status", status);
  target.replaceChildren(new Option("저장된 기사 불러오는 중", ""));
  updateActions();

  try {
    const { articles } = await api(`/api/articles?${query}`);
    if (request !== editorListRequest) return;
    target.replaceChildren(new Option(articles.length ? "기사 선택" : "저장된 기사가 없습니다.", ""));
    for (const item of articles) {
      target.add(new Option(item.title, item.article_id));
    }
    target.value = articles.some(item => item.article_id === article?.article_id) ? article.article_id : "";
  } catch (error) {
    if (request === editorListRequest) target.replaceChildren(new Option(error.message, ""));
  } finally {
    updateActions();
  }
}

async function refreshArchive() {
  const request = ++archiveRequest;
  const list = byId("article-list");
  const title = byId("library-article-title");
  const preview = byId("library-preview");
  try {
    const { articles } = await api("/api/articles?status=approved&limit=100");
    if (request !== archiveRequest) return;
    list.replaceChildren();
    if (!articles.length) {
      list.textContent = "승인된 기사가 없습니다.";
      title.textContent = "기사 본문";
      preview.textContent = "편집장 승인 후 보도창에 표시됩니다.";
      archiveArticleId = null;
      return;
    }

    const selected = articles.find(item => item.article_id === archiveArticleId) || articles[0];
    function showArchivedArticle(item) {
      archiveArticleId = item.article_id;
      title.textContent = item.title;
      preview.textContent = item.body;
      for (const button of list.querySelectorAll("button")) {
        const current = button.dataset.articleId === item.article_id;
        button.classList.toggle("is-current", current);
        button.setAttribute("aria-pressed", String(current));
      }
    }

    for (const item of articles) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.articleId = item.article_id;
      const headline = document.createElement("strong");
      headline.textContent = item.title;
      const status = document.createElement("small");
      status.textContent = item.published ? "게시 완료" : "편집장 승인 완료";
      button.append(headline, status);
      button.onclick = () => showArchivedArticle(item);
      list.append(button);
    }
    showArchivedArticle(selected);
  } catch (error) {
    if (request !== archiveRequest) return;
    list.textContent = error.message;
    title.textContent = "기사 본문";
    preview.textContent = "";
  }
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

byId("refresh-articles").onclick = refreshArchive;
byId("article-filter").onchange = refreshEditorArticles;
byId("editor-article-select").onchange = async (event) => {
  const articleId = event.target.value;
  if (!articleId || busy) return;
  busy = true;
  updateActions();
  try {
    showArticle(await api(`/api/articles/${articleId}`));
    byId("status").textContent = states[article.status] || article.status;
    await refreshAudit();
  } catch (error) {
    byId("status").textContent = error.message;
  } finally {
    busy = false;
    updateActions();
  }
};

// traffic-reference-ui-v1: same tabbed newsroom structure as the traffic reference.
const workspaceViews = new Set(["election", "draft", "library"]);
function openWorkspaceView(name) {
  if (!workspaceViews.has(name)) return;
  for (const [elementId, slotName] of [
    ["count-ticker", "ticker"],
    ["count-replay-controls", "replay"],
  ]) {
    const slot = byId(`${name}-${slotName}-slot`);
    const element = byId(elementId);
    if (slot && element.parentElement !== slot) {
      slot.append(element);
    }
  }
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
  if (name === "library") refreshArchive();
  if (name === "draft") refreshEditorArticles();
}
byId("site-brand-link")?.addEventListener("click", (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  openWorkspaceView("election");
  window.scrollTo(0, 0);
});
document.querySelectorAll("[data-view], [data-go]").forEach((button) => {
  button.addEventListener("click", () => openWorkspaceView(button.dataset.view || button.dataset.go));
});
const syncWorkspaceCurrent = () => {
  const name = article ? `${article.title}\n\n상태: ${states[article.status] || article.status}\n${article.article_type === "pledge" ? "공약 기사" : `${article.snapshot?.step_id ?? "—"}단계`}` : "선택된 기사가 없습니다.";
  byId("review-current-status").textContent = name;
};
// The existing workflow owns article state; read it when panels are opened.
document.querySelectorAll("[data-view], [data-go]").forEach((button) => {
  button.addEventListener("click", syncWorkspaceCurrent);
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
      const data = await api(`/api/rag/answer?replay=false&q=${encodeURIComponent(question)}`);
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

const countTimelineData = api("/api/count-timeline").then(data => {
  if (!Array.isArray(data) || data.length < 2) throw new Error("개표 타임라인 데이터 형식이 다릅니다.");
  replayFrames = data;
  renderCandidateBars(data.at(-1).candidates, true);
  byId("start").disabled = false;
  byId("restart").disabled = false;
  return data;
}).catch(error => {
  setTickerText("재생 데이터를 불러오지 못했어요. 페이지를 새로고침해 주세요.");
  throw error;
});

document.addEventListener("count-history-select", (event) => {
  render(event.detail);
});

// Plot only checkpoints that contain reported candidate results.
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
    const start = Date.parse(replayFrames[0].timestamp_kst);
    const duration = Date.parse(replayFrames.at(-1).timestamp_kst) - start;
    const x = (index) => L + (width - L - R) *
      ((Date.parse(frames[index].timestamp_kst) - start) / duration);
    const y=v=>T+(height-T-B)*(1-(v-min)/Math.max(1,max-min));
    const svg=svgNode("svg",{viewBox:`0 0 ${width} ${height}`,role:"img","aria-label":labels.join(", ")+" 보도 집계 추이"});
    for(let k=0;k<=4;k++){
      const v=min+(max-min)*k/4, yy=y(v);
      svg.appendChild(svgNode("line",{x1:L,y1:yy,x2:width-R,y2:yy,stroke:"#dae6e4","stroke-dasharray":"3 4"}));
      svg.appendChild(svgNode("text",{x:L-6,y:yy+4,"text-anchor":"end",fill:"#71828e","font-size":10},format(v)));
    }
    series.forEach((points,idx)=>{
      svg.appendChild(svgNode("polyline",{points:points.map((v,i)=>`${x(i)},${y(v)}`).join(" "),stroke:["#176b5c","#3988b7"][idx],"stroke-width":2.7,fill:"none","stroke-linejoin":"round","stroke-linecap":"round"}));
      if(selected>=1 && selected<=points.length) svg.appendChild(svgNode("circle",{cx:x(selected-1),cy:y(points[selected-1]),r:4,fill:["#176b5c","#3988b7"][idx],stroke:"#fff","stroke-width":1.5}));
    });
    [0, 0.5, 1].forEach(fraction => {
      const label = clock.format(new Date(start + duration * fraction));
      svg.appendChild(svgNode("text", {
        x: L + (width - L - R) * fraction, y: height - 8, "text-anchor": "middle",
        fill: "#71828e", "font-size": 11,
      }, label));
    });
    container.append(svg);
    const legend=document.createElement("div");legend.className="trend-legend";
    legend.style.cssText="font-size:11px;color:#526b6b;display:flex;gap:16px;justify-content:center;margin-top:5px";
    labels.forEach((label,idx)=>{const span=document.createElement("span");span.textContent=`● ${label}`;span.style.color=["#176b5c","#3988b7"][idx];legend.append(span);});
    container.append(legend);
  };
  const update=() => {
    if(!frames.length)return;
    const two = frames.map(frame =>
      ["seoul-1", "seoul-2"].map(id => frame.candidates.find(candidate => candidate.candidate_id === id)));
    const first=two.map(pair=>pair[0].vote_rate),second=two.map(pair=>pair[1].vote_rate);
    const low=Math.floor((Math.min(...first,...second)-1)/2)*2;
    const high=Math.ceil((Math.max(...first,...second)+1)/2)*2;
    plot("rate-trend",[first,second],low,high,[two[0][0].candidate_name,two[0][1].candidate_name],v=>v.toFixed(0)+"%",activeStep);
    const gap=two.map(pair=>pair[0].votes-pair[1].votes);
    const abs=Math.ceil(Math.max(...gap.map(Math.abs),1000)/10000)*10000;
    plot("gap-trend",[gap],-abs,abs,[`${two[0][0].candidate_name} − ${two[0][1].candidate_name}`],v=>Math.round(v/10000)+"만",activeStep);
  };
  const originalRender = render;
  render = function (frame) {
    originalRender(frame);
    activeStep = frames.findIndex(entry => entry.step_id === frame.step_id) + 1;
    update();
  };
  countTimelineData.then(data => {
    frames = data.filter(entry => entry.counted_rate !== null && entry.time_basis !== "simulated");
    update();
  }).catch(error => {
    byId("rate-trend").textContent = "개표 추이 로드 실패: " + error.message;
    byId("gap-trend").textContent = "데이터를 불러올 수 없습니다.";
  });
})();

// Live headlines on the election board: show the editing room's articles for the
// replay stage being played (breaking) and rotate through pledge articles.
(() => {
  const breakingSlot = byId("live-headline-breaking");
  const pledgeSlot = byId("live-headline-pledge");
  const statusRank = { approved: 4, human_reviewed: 3, fact_checked: 2, draft: 1 };
  let liveArticles = [];
  let currentStep = 0;
  let liveRequest = 0;

  const better = (a, b) => (statusRank[a.status] || 0) > (statusRank[b.status] || 0);

  function fill(slot, item, emptyText, meta) {
    const strong = slot.querySelector("strong");
    const small = slot.querySelector("small");
    const changed = slot.dataset.articleId !== (item?.article_id || "");
    slot.dataset.articleId = item?.article_id || "";
    slot.disabled = !item;
    slot.classList.toggle("is-empty", !item);
    strong.textContent = item ? item.title : emptyText;
    small.textContent = meta;
    if (item && changed) {
      slot.classList.remove("is-updated");
      void slot.offsetWidth;
      slot.classList.add("is-updated");
    }
  }

  function renderLiveHeadlines() {
    const total = replayFrames.length || 15;
    if (!currentStep) {
      fill(breakingSlot, null, "개표 재생을 시작하면 편집실 속보 기사가 표시됩니다.", `1~${total}단계 개표 기사`);
    } else {
      let pick = null;
      for (const item of liveArticles) {
        const step = item.snapshot?.step_id;
        if (item.article_type === "pledge" || !step || step > currentStep) continue;
        if (!pick || step > pick.snapshot.step_id || (step === pick.snapshot.step_id && better(item, pick))) pick = item;
      }
      if (pick) {
        const step = pick.snapshot.step_id;
        const lag = step === currentStep ? "" : ` · 현재 ${currentStep}단계 기사 대기 중`;
        fill(breakingSlot, pick, "", `${step}/${total}단계 · ${states[pick.status] || pick.status}${lag}`);
      } else {
        fill(breakingSlot, null, `${currentStep}단계까지 작성된 속보 기사가 없습니다. 편집실에서 초안을 작성해 주세요.`, `${currentStep}/${total}단계`);
      }
    }

    const pledges = liveArticles.filter(item => item.article_type === "pledge");
    if (!pledges.length) {
      fill(pledgeSlot, null, "편집실에서 작성한 공약 기사가 아직 없습니다.", "후보 공약 기사");
    } else {
      const index = Math.max(0, currentStep - 1) % pledges.length;
      const item = pledges[index];
      fill(pledgeSlot, item, "", `공약 기사 ${index + 1}/${pledges.length} · ${states[item.status] || item.status}`);
    }
  }

  async function refreshLiveHeadlines() {
    const request = ++liveRequest;
    try {
      const { articles } = await api("/api/articles?limit=100");
      if (request !== liveRequest) return;
      liveArticles = articles.filter(item => item.status !== "rejected");
    } catch {
      // Keep the last known headlines if the list cannot be refreshed.
    }
    renderLiveHeadlines();
  }

  const showStep = (frame) => {
    currentStep = frame?.step_id || 0;
    refreshLiveHeadlines();
  };

  const previousRender = render;
  render = function (frame) {
    previousRender(frame);
    showStep(frame);
  };

  // Articles written or approved in the editing room show up without waiting for the next stage.
  const previousRefreshEditor = refreshEditorArticles;
  refreshEditorArticles = async function (...args) {
    refreshLiveHeadlines();
    return previousRefreshEditor.apply(this, args);
  };

  for (const slot of [breakingSlot, pledgeSlot]) {
    slot.addEventListener("click", async () => {
      const articleId = slot.dataset.articleId;
      if (!articleId || busy) return;
      openWorkspaceView("draft");
      window.scrollTo({ top: 0, behavior: "smooth" });
      try {
        showArticle(await api(`/api/articles/${articleId}`));
        byId("status").textContent = states[article.status] || article.status;
        byId("editor-article-select").value = articleId;
        await refreshAudit();
      } catch (error) {
        byId("status").textContent = error.message;
      }
    });
  }

  refreshLiveHeadlines();
})();
