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
};

async function editorialAction(operation) {
  if (busy) return;
  busy = true;
  updateActions();
  try {
    const result = await operation();
    article = result.article || result;
    byId("article-title").textContent = article.title;
    byId("article-body").textContent = article.body;
    byId("status").textContent = result.result?.reason || states[article.status];
  } catch (error) {
    byId("status").textContent = error.message;
  } finally {
    busy = false;
    updateActions();
  }
}

function createDraft(frame) {
  return editorialAction(() => api("/api/articles", { snapshot: frame }, "POST"));
}

byId("draft").onclick = () => createDraft(snapshot);
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
