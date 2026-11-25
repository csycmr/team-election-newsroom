const byId = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("ko-KR");
const clock = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "long", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const headlineClock = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function formatHeadlineTime(value) {
  const parts = Object.fromEntries(headlineClock.formatToParts(new Date(value)).map(({ type, value }) => [type, value]));
  return `${Number(parts.month)}월 ${Number(parts.day)}일 ${parts.hour}시 ${parts.minute}분`;
}
function formatHeadlineMargin(votes) {
  if (votes >= 10_000) {
    const tenThousands = Math.floor(votes / 10_000);
    const remainder = votes % 10_000;
    return `${number.format(tenThousands)}만${remainder ? ` ${number.format(remainder)}` : ""}표`;
  }
  return `${number.format(votes)}표`;
}
const colors = ["#ed737e", "#679bff", "#f3cd58", "#b896ff", "#f2a875"];

const breakingEvents = new Set([
  "투표용지 부족으로 잠실7동 제2투표소 투표 연장",
  "오세훈 역전",
  "잠실7동 제2투표소 투표함 2개 이송",
]);

const ticker = byId("ticker");
const tickerTrack = ticker.parentElement;
const tickerHeadline = document.createElement("span");
tickerHeadline.className = "ticker-headline";
tickerHeadline.textContent = ticker.textContent;
const tickerStage = document.createElement("small");
tickerStage.className = "ticker-stage";
tickerStage.textContent = "개표 재생 대기";
ticker.replaceChildren(tickerHeadline, tickerStage);

const tickerWindow = tickerTrack.parentElement;
const tickerMotion = window.matchMedia("(prefers-reduced-motion: no-preference)");
const tickerPixelsPerSecond = 180;
const tickerGap = 24;
const tickerPasses = new Map();
let latestTickerRow = ticker;
let latestTickerStage = tickerStage.textContent;

function removeTickerPass(row) {
  tickerPasses.get(row)?.animation.cancel();
  tickerPasses.delete(row);
  tickerResize.unobserve(row);
  row.remove();
}

function tickerPosition(pass) {
  return pass.start - Number(pass.animation.currentTime) * tickerPixelsPerSecond / 1000;
}

function animateTickerRow(row, precedingRow) {
  const previous = tickerPasses.get(row);
  const windowWidth = tickerWindow.clientWidth;
  const rowWidth = row.offsetWidth;

  if (!tickerMotion.matches || !windowWidth || !rowWidth) {
    if (row !== latestTickerRow) removeTickerPass(row);
    else {
      previous?.animation.cancel();
      tickerPasses.delete(row);
    }
    return;
  }

  // Once a headline starts, keep its path intact across layout changes.
  if (previous) return;

  const preceding = tickerPasses.get(precedingRow);
  const precedingEnd = preceding
    ? tickerPosition(preceding) + precedingRow.offsetWidth + tickerGap
    : 0;
  const start = Math.max(windowWidth, precedingEnd);
  const animation = row.animate([
    { transform: `translateX(${start}px)` },
    { transform: `translateX(${-rowWidth}px)` },
  ], { duration: (start + rowWidth) * 1000 / tickerPixelsPerSecond, fill: "both" });
  tickerPasses.set(row, { animation, start });
  animation.onfinish = () => {
    if (tickerPasses.get(row)?.animation !== animation) return;
    if (row === latestTickerRow) {
      tickerPasses.delete(row);
      animation.cancel();
      animateTickerRow(row);
    } else {
      removeTickerPass(row);
    }
  };
}

function setTickerText(message, stageText) {
  if (stageText !== undefined) latestTickerStage = stageText;
  const previous = latestTickerRow;
  const row = ticker.cloneNode(true);
  row.removeAttribute("id");
  row.querySelector(".ticker-headline").textContent = message;
  row.querySelector(".ticker-stage").textContent = latestTickerStage;

  latestTickerRow = row;
  if (tickerPasses.has(previous)) previous.setAttribute("aria-hidden", "true");
  else removeTickerPass(previous);
  tickerTrack.append(row);
  animateTickerRow(row, previous);
  tickerResize.observe(row);
}

function refreshTickerAnimations() {
  let precedingRow;
  for (const row of Array.from(tickerTrack.children)) {
    animateTickerRow(row, precedingRow);
    if (tickerPasses.has(row)) precedingRow = row;
  }
}

const tickerResize = new ResizeObserver(refreshTickerAnimations);
tickerResize.observe(tickerWindow);
tickerResize.observe(ticker);
tickerMotion.addEventListener("change", refreshTickerAnimations);

function compactCountHeadline(frame, latestCount) {
  const approximate = frame.time_basis === "approximate" ? "경" : "";
  const publication = frame.time_basis === "publication_time" ? " 보도 시각" : "";
  const current = approximate || publication ? "" : " 현재";
  const parts = [`${formatHeadlineTime(frame.timestamp_kst)}${approximate}${publication}${current}`];
  const count = frame.counted_rate === null ? latestCount : frame;
  const ranked = [...(count?.candidates ?? [])].sort((a, b) => b.votes - a.votes);

  if (frame.counted_rate !== null && frame.counted_rate_pct != null) {
    parts.push(`개표율 ${Number(frame.counted_rate_pct).toString()}%`);
  } else if (count?.counted_rate_pct != null) {
    parts.push(`직전 집계 ${Number(count.counted_rate_pct).toString()}%`);
  }

  if (ranked.length > 1) {
    const margin = ranked[0].votes - ranked[1].votes;
    const qualifier = frame.counted_rate === null ? "직전 선두" : "선두";
    const reversal = frame.event?.includes("역전") ? " 역전" : "";
    parts.push(`${ranked[0].candidate_name} ${formatHeadlineMargin(margin)} 차 ${qualifier}${reversal}`);
  } else if (ranked.length === 1) {
    parts.push(`${ranked[0].candidate_name} 선두`);
  }

  const event = frame.event || "";
  if (event.includes("투표용지 부족")) parts.push("잠실7동 투표용지 부족으로 투표 연장");
  else if (event.includes("투표함 2개")) parts.push("잠실7동 투표함 2개 이송");
  else if (event.includes("최종 개표 완료")) parts.push("최종 개표 완료");
  else if (event.includes("개표 시작")) parts.push("개표 시작");

  return parts.join(" · ");
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
  const approximate = frame.time_basis === "approximate" ? "경" : "";
  const isSimulation = frame.time_basis === "simulated";
  const eventTitle = isSimulation ? "개표 진행" : frame.event;
  byId("clock").textContent = `${timestamp}${approximate} KST · ${eventTitle}`;
  byId("progress").textContent = lastCount ? lastCount.counted_rate_pct + "%" : "—";
  byId("total").textContent = total === null ? "—" : number.format(total);
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
  const headline = compactCountHeadline(frame, lastCount);
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

// Articles sent back with 수정 must go through 초안 저장 again before the next fact check.
const needsSave = new Set();

function updateActions() {
  byId("draft").disabled = busy || !snapshot;
  byId("replay-draft").disabled = busy || !snapshot;
  byId("pledge-draft").disabled = busy;
  byId("editor-article-select").disabled = busy || byId("editor-article-select").options.length < 2;
  byId("save").disabled = busy || !article || !["draft", "fact_checked"].includes(article.status);
  byId("article-title-input").disabled = busy || !article || !["draft", "fact_checked"].includes(article.status);
  byId("article-body-input").disabled = busy || !article || !["draft", "fact_checked"].includes(article.status);
  byId("check").disabled = busy || article?.status !== "draft" || needsSave.has(article?.article_id);
  byId("revise-article").disabled = busy || !article || article.status === "draft";
  byId("review").disabled = busy || article?.status !== "fact_checked";
  const decisionDisabled = busy || article?.status !== "human_reviewed";
  byId("approve").disabled = decisionDisabled;
  byId("reject").disabled = decisionDisabled;
  const status = article?.status;
  byId("check").closest("section").classList.toggle("is-stamped", ["fact_checked", "human_reviewed", "approved"].includes(status));
  byId("review").closest("section").classList.toggle("is-stamped", ["human_reviewed", "approved"].includes(status));
  byId("approve").closest("section").classList.toggle("is-stamped", status === "approved");
  const deleteButton = byId("delete-article");
  deleteButton.disabled = busy || !article || postedArticleIds.has(article.article_id);
  deleteButton.title = article && postedArticleIds.has(article.article_id)
    ? "보도실에 게시된 기사는 보도실에서 삭제해 주세요." : "";
  const postButton = byId("post-article");
  const approved = article?.status === "approved";
  const posted = approved && postedArticleIds.has(article.article_id);
  postButton.textContent = posted ? "보도실 게시 완료" : approved ? "보도실에 게시" : "편집장 승인 전";
  postButton.classList.toggle("is-ready", approved && !posted);
  postButton.classList.toggle("is-posted", posted);
  postButton.disabled = busy || !approved || posted;
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

// 01 박스 상태 문구에는 '편집장 승인 완료'를 띄우지 않는다 (승인 상태는 04 박스에 표시).
const statusLine = (item) => (item.status === "approved" ? "" : states[item.status] || item.status);

// The 01 box status line stays blank except when something fails.
function showStatusError(message) {
  const line = byId("status");
  line.textContent = message;
  line.classList.add("has-error");
}

async function editorialAction(operation, feedbackId = "status", onSuccess) {
  if (busy) return;
  const feedback = byId(feedbackId);
  byId("status").classList.remove("has-error");
  if (feedbackId !== "status") byId("status").textContent = "";
  busy = true;
  updateActions();
  try {
    const result = await operation();
    showArticle(result.article || result);
    onSuccess?.();
    feedback.textContent = result.result?.reason || (feedbackId === "status" ? statusLine(article) : states[article.status]);
    if (result.result && result.result.status !== "pass") {
      feedback.textContent += ` (${result.result.status})`;
    }
    if (feedbackId === "factcheck-status") renderFactIssues(result.result?.issues || []);
    await Promise.all([refreshEditorArticles(), refreshArchive(), refreshAudit()]);
  } catch (error) {
    feedback.textContent = error.message;
    if (feedbackId === "status") feedback.classList.add("has-error");
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
byId("save").onclick = () => {
  const id = article.article_id;
  editorialAction(() =>
    api(`/api/articles/${id}`, {
      title: byId("article-title-input").value,
      body: byId("article-body-input").value,
    }, "PUT"), "status", () => needsSave.delete(id));
};

byId("revise-article").onclick = async () => {
  if (busy || !article || article.status === "draft") return;
  if (!window.confirm("수정하면 팩트체크·사람 검토·편집장 승인(도장)이 모두 취소되고 초안으로 돌아가요.\n초안 저장부터 다시 해야 하고, 보도실에 게시된 기사는 게시가 내려가요. 계속할까요?")) return;
  const id = article.article_id;
  await editorialAction(
    () => api(`/api/articles/${id}/revise`, undefined, "POST"),
    "status",
    () => {
      needsSave.add(id);
      postedArticleIds.delete(id);
    },
  );
  byId("status").textContent = "수정 모드입니다. 내용을 고친 뒤 '초안 저장'부터 다시 진행해 주세요.";
};
// 적용 등으로 원고가 바뀌었으면 먼저 저장한 뒤 그 내용으로 팩트체크한다.
byId("check").onclick = () => editorialAction(async () => {
  const id = article.article_id;
  const title = byId("article-title-input").value;
  const body = byId("article-body-input").value;
  if (title !== article.title || body !== article.body) {
    await api(`/api/articles/${id}`, { title, body }, "PUT");
    needsSave.delete(id);
  }
  return api(`/api/articles/${id}/fact-check`, undefined, "POST");
}, "factcheck-status");

for (const [button, endpoint] of [["review", "human-review"], ["approve", "approve"], ["reject", "reject"]]) {
  byId(button).onclick = () => {
    const feedbackId = button === "review" ? "human-review-status" : "editor-decision-status";
    const reviewer = byId("reviewer").value.trim();
    if (!reviewer) {
      byId(feedbackId).textContent = "검토자 이름을 입력해 주세요.";
      byId("reviewer").focus();
      return;
    }
    editorialAction(() => api(`/api/articles/${article.article_id}/${endpoint}`, { reviewer }, "POST"), feedbackId);
  };
}

// 팩트체크 실패 시 원문 · 오류사항 · 수정 제안 · 적용 버튼을 02 박스 아래에 보여준다.
const factEl = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function renderFactIssues(issues) {
  const target = byId("factcheck-issues");
  target.replaceChildren();
  for (const issue of issues) {
    const card = factEl("section", "factcheck-issue");
    card.append(factEl("h4", "", issue.field));
    const row = (label, text, className) => {
      const line = factEl("p", `factcheck-line ${className}`);
      line.append(factEl("span", "factcheck-label", label), factEl("span", "factcheck-text", text));
      return line;
    };
    card.append(
      row("원문", issue.original || "(원문에 해당 문구가 없어요)", "is-original"),
      row("오류사항", issue.message, "is-error"),
    );
    if (issue.suggestion) {
      card.append(row("수정 제안", issue.suggestion, "is-suggestion"));
      const apply = factEl("button", "primary factcheck-apply", "적용");
      apply.type = "button";
      const note = factEl("p", "factcheck-note");
      apply.onclick = () => {
        const field = byId(issue.target === "title" ? "article-title-input" : "article-body-input");
        if (field.disabled) { note.textContent = "지금은 원고를 고칠 수 없는 상태예요."; return; }
        let value = field.value;
        if (issue.action === "replace") {
          if (!value.includes(issue.original)) { note.textContent = "원문에서 해당 문구를 찾지 못했어요. 이미 고쳤을 수 있어요."; return; }
          value = value.replace(issue.original, () => issue.suggestion);
        } else {
          const at = value.lastIndexOf("출처:");
          value = at > 0 ? `${value.slice(0, at)}${issue.suggestion} ${value.slice(at)}` : `${value} ${issue.suggestion}`.trim();
        }
        field.value = value;
        apply.disabled = true;
        apply.textContent = "적용됨";
        note.textContent = "원고에 반영했어요. '팩트체크'를 다시 누르면 저장 후 검사해요.";
      };
      card.append(apply, note);
    } else {
      card.append(factEl("p", "factcheck-note", "자동으로 고칠 수 없는 항목이에요. 원 데이터나 근거를 확인해 주세요."));
    }
    target.append(card);
  }
}

function showArticle(next) {
  if (article?.article_id !== next.article_id || next.status === "draft") {
    byId("factcheck-issues").replaceChildren();
    byId("editor-decision-status").textContent = "";
    byId("factcheck-status").textContent = "";
    byId("human-review-status").textContent = "";
  }
  if (article?.article_id !== next.article_id) byId("post-status").textContent = "";
  article = next;
  byId("article-title-input").value = next.title;
  byId("article-body-input").value = next.body;
  const ids = (next.evidence || []).map(item => item.evidence_id).join(", ");
  byId("article-evidence").textContent = ids ? `연결 근거 ID: ${ids}` : "연결된 근거 없음";
  updateActions();
}

let editorListRequest = 0;
const postedArticleIds = new Set();

function rememberPosted(articles) {
  for (const item of articles) {
    if (item.posted) postedArticleIds.add(item.article_id);
  }
}

byId("post-article").onclick = async () => {
  if (busy || article?.status !== "approved") return;
  const feedback = byId("post-status");
  busy = true;
  updateActions();
  try {
    await api(`/api/articles/${article.article_id}/post`, undefined, "POST");
    postedArticleIds.add(article.article_id);
    archiveArticleId = article.article_id;
    feedback.textContent = "";
    await Promise.all([refreshEditorArticles(), refreshArchive(), refreshAudit()]);
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    busy = false;
    updateActions();
  }
};
let archiveRequest = 0;
let archiveArticleId = null;

byId("delete-article").onclick = async () => {
  if (busy || !article) return;
  const target = article;
  if (!window.confirm(`「${target.title}」 기사를 삭제할까요?\n저장 목록에서 사라지고 되돌릴 수 없어요.`)) return;
  const feedback = byId("post-status");
  busy = true;
  updateActions();
  try {
    await api(`/api/articles/${target.article_id}`, undefined, "DELETE");
    postedArticleIds.delete(target.article_id);
    article = undefined;
    byId("article-title-input").value = "";
    byId("article-body-input").value = "";
    byId("article-evidence").textContent = "";
    byId("factcheck-status").textContent = "";
    byId("human-review-status").textContent = "";
    feedback.textContent = "";
    byId("status").textContent = "기사를 삭제했습니다.";
    archiveArticleId = null;
    busy = false;
    await Promise.all([refreshEditorArticles(), refreshArchive(), refreshAudit()]);
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    busy = false;
    updateActions();
  }
};

function updateStatusCounts(articles) {
  const counts = {};
  for (const item of articles) counts[item.status] = (counts[item.status] || 0) + 1;
  for (const option of byId("article-filter").options) {
    option.dataset.label ??= option.textContent;
    const count = option.value ? counts[option.value] || 0 : articles.length;
    option.textContent = `${option.dataset.label} (${count})`;
  }
}

async function refreshEditorArticles() {
  const request = ++editorListRequest;
  const target = byId("editor-article-select");
  const status = byId("article-filter").value;
  const query = new URLSearchParams({ limit: "100" });
  if (status) query.set("status", status);
  target.replaceChildren(new Option("저장된 기사 불러오는 중", ""));
  updateActions();

  try {
    const [{ articles }, { articles: everything }] = await Promise.all([
      api(`/api/articles?${query}`),
      status ? api("/api/articles?limit=100") : Promise.resolve({ articles: null }),
    ]);
    if (request !== editorListRequest) return;
    rememberPosted(articles);
    if (everything) rememberPosted(everything);
    // Articles already posted to the 보도실 are managed there, not in the editing room's saved list.
    const unposted = (list) => list.filter((item) => !item.posted);
    const saved = unposted(articles);
    updateStatusCounts(unposted(everything || articles));
    target.replaceChildren(new Option(saved.length ? "기사 선택" : "저장된 기사가 없습니다.", ""));
    for (const item of saved) {
      target.add(new Option(item.title, item.article_id));
    }
    target.value = saved.some(item => item.article_id === article?.article_id) ? article.article_id : "";
  } catch (error) {
    if (request === editorListRequest) target.replaceChildren(new Option(error.message, ""));
  } finally {
    updateActions();
  }
}

const boardDate = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
});
const articleDate = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const dotted = (formatter, value) => formatter.format(new Date(value)).replace(/\.\s?/g, ".").replace(/\.$/, "").replace(/\.(\d{2}:)/, " $1");

function articleParagraphs(body) {
  const blocks = body.split(/\n+/).map(text => text.trim()).filter(Boolean);
  if (blocks.length > 1) return blocks;
  const sentences = body.split(/(?<=[.!?])\s+/).map(text => text.trim()).filter(Boolean);
  const paragraphs = [];
  for (let index = 0; index < sentences.length; index += 2) {
    paragraphs.push(sentences.slice(index, index + 2).join(" "));
  }
  return paragraphs;
}

function renderNewsArticle(item) {
  const target = byId("library-article");
  target.replaceChildren();
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const kicker = element("p", "news-kicker", item.article_type === "pledge" ? "공약" : "개표 속보");
  const title = element("h4", "news-title", item.title);
  const byline = element("div", "news-byline");
  byline.append(
    element("span", "news-author", `${item.author || "AI 뉴스룸"} 기자`),
    element("span", "", `입력 ${dotted(articleDate, item.dated_at || item.created_at)}`),
    element("span", "", item.board_number ? `No. ${item.board_number}` : "보도실 게시 대기"),
  );
  const body = element("div", "news-body");
  for (const paragraph of articleParagraphs(item.body)) body.append(element("p", "", paragraph));
  target.append(kicker, title, byline, body);

  const evidence = (item.evidence || []).filter(source => source.source_url);
  if (evidence.length) {
    const sources = element("aside", "news-sources");
    sources.append(element("strong", "", "근거 자료"));
    const list = element("ul");
    for (const source of evidence) {
      const row = element("li");
      const link = element("a", "", `[${source.evidence_id}] ${source.title || source.source}`);
      link.href = source.source_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      row.append(link);
      list.append(row);
    }
    sources.append(list);
    target.append(sources);
  }
  target.append(element("p", "news-note", item.posted_at
    ? "이 기사는 AI 도구로 초안을 작성한 뒤 팩트체크, 사람 검토, 편집장 승인을 거쳐 게시했습니다."
    : "상황판 실시간 기사에서 선택한 원고입니다. 보도실 게시 전 상태예요."));

  if (!item.posted_at) return;
  const actions = element("div", "news-actions");
  const feedback = element("p", "news-feedback");
  feedback.setAttribute("role", "status");
  const edit = element("button", "news-edit", "수정");
  const remove = element("button", "news-delete", "삭제");
  edit.type = remove.type = "button";
  actions.append(edit, remove);
  target.append(actions, feedback);

  const run = async (operation) => {
    if (busy) return;
    busy = true;
    edit.disabled = remove.disabled = true;
    try {
      await operation();
    } catch (error) {
      feedback.textContent = error.message;
      edit.disabled = remove.disabled = false;
    } finally {
      busy = false;
      updateActions();
    }
  };

  edit.onclick = () => {
    if (!window.confirm("보도실 게시를 내리고 초안으로 되돌려 편집실에서 수정합니다.\n수정 후 다시 팩트체크·사람 검토·편집장 승인을 거쳐야 게시할 수 있어요. 계속할까요?")) return;
    run(async () => {
      const revised = await api(`/api/articles/${item.article_id}/revise`, undefined, "POST");
      postedArticleIds.delete(item.article_id);
      needsSave.add(item.article_id);
      openWorkspaceView("draft");
      window.scrollTo({ top: 0, behavior: "smooth" });
      showArticle(revised);
      byId("status").textContent = "보도실 게시를 내리고 초안으로 되돌렸습니다. 수정 후 '초안 저장'부터 다시 진행해 주세요.";
      await Promise.all([refreshEditorArticles(), refreshArchive(), refreshAudit()]);
    });
  };

  remove.onclick = () => {
    if (!window.confirm(`「${item.title}」 기사를 삭제할까요?\n삭제하면 보도실과 편집실에서 모두 사라지고 되돌릴 수 없어요.`)) return;
    run(async () => {
      await api(`/api/articles/${item.article_id}`, undefined, "DELETE");
      postedArticleIds.delete(item.article_id);
      if (article?.article_id === item.article_id) {
        article = undefined;
        byId("article-title-input").value = "";
        byId("article-body-input").value = "";
        byId("article-evidence").textContent = "";
      }
      archiveArticleId = null;
      await refreshArchive();
    });
  };
}

async function refreshArchive() {
  const request = ++archiveRequest;
  const list = byId("article-list");
  const showEmpty = (message) => {
    byId("library-article").replaceChildren(Object.assign(document.createElement("p"), {
      className: "news-empty", textContent: message,
    }));
  };
  try {
    const { articles: approved } = await api("/api/articles?status=approved&limit=100");
    if (request !== archiveRequest) return;
    rememberPosted(approved);
    const articles = approved
      .filter(item => item.posted_at)
      .sort((a, b) => Date.parse(a.dated_at) - Date.parse(b.dated_at) || Date.parse(a.posted_at) - Date.parse(b.posted_at))
      .map((item, index) => ({ ...item, board_number: index + 1 }))
      .reverse();
    list.replaceChildren();
    if (!articles.length) {
      list.textContent = "보도실에 게시된 기사가 없습니다.";
      showEmpty("편집실에서 편집장 승인 후 '보도실에 게시'를 누르면 여기에 표시됩니다.");
      archiveArticleId = null;
      return;
    }

    const table = document.createElement("table");
    table.innerHTML = '<thead><tr><th scope="col">번호</th><th scope="col">제목</th><th scope="col">게시일</th><th scope="col">작성자</th></tr></thead>';
    const rows = document.createElement("tbody");
    table.append(rows);

    function showArchivedArticle(item) {
      archiveArticleId = item.article_id;
      renderNewsArticle(item);
      for (const row of rows.rows) {
        const current = row.dataset.articleId === item.article_id;
        row.classList.toggle("is-current", current);
        row.querySelector("button").setAttribute("aria-current", String(current));
      }
    }

    for (const item of articles) {
      const row = rows.insertRow();
      row.dataset.articleId = item.article_id;
      row.insertCell().textContent = item.board_number;
      const titleCell = row.insertCell();
      titleCell.className = "board-title";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.title;
      const kind = document.createElement("span");
      kind.className = "board-kind";
      kind.textContent = item.article_type === "pledge" ? "공약" : "속보";
      titleCell.append(kind, button);
      row.insertCell().textContent = dotted(boardDate, item.dated_at);
      row.insertCell().textContent = item.author;
      row.onclick = () => showArchivedArticle(item);
    }
    list.append(table);
    showArchivedArticle(articles.find(item => item.article_id === archiveArticleId) || articles[0]);
  } catch (error) {
    if (request !== archiveRequest) return;
    list.textContent = error.message;
    showEmpty("");
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
    byId("status").textContent = statusLine(article);
    await refreshAudit();
  } catch (error) {
    showStatusError(error.message);
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

// Live headline on the election board: one row that follows the replay.
// While the count has no figures yet (start → first ~3% count) it alternates two
// pledge articles; once figures arrive it shows the newsroom article for the
// current stage. Titles slide up from below when they change.
(() => {
  const slot = byId("live-headline");
  const kind = byId("live-headline-kind");
  const viewport = slot.querySelector(".live-headline-window");
  const statusRank = { approved: 4, human_reviewed: 3, fact_checked: 2, draft: 1 };
  const PLEDGE_SWAP_MS = 2500;
  let liveArticles = [];
  let currentStep = 0;
  let liveRequest = 0;
  let pledgeIndex = 0;
  let pledgeTimer = null;
  let shownKey = null;

  const better = (a, b) => (statusRank[a.status] || 0) > (statusRank[b.status] || 0);

  function liveArticleTitle(item) {
    const snapshot = item.snapshot;
    if (item.article_type === "pledge" || !snapshot?.collected_at) return item.title;

    const stamp = formatHeadlineTime(snapshot.collected_at);
    const timePhrase = snapshot.time_basis === "approximate"
      ? `${stamp}경`
      : snapshot.time_basis === "publication_time" ? `${stamp} 보도 기준` : `${stamp} 현재`;
    const event = snapshot.timeline_event || "";
    if (snapshot.counted_rate == null || !snapshot.candidates?.length) {
      if (event.includes("투표용지 부족")) {
        return `[서울시장 개표상황] ${timePhrase}, 잠실7동 투표용지 부족으로 투표가 연장됐습니다.`;
      }
      if (event.includes("투표함 2개")) {
        return `[서울시장 개표상황] ${timePhrase}, 잠실7동 투표함 2개가 이송됐습니다.`;
      }
      if (event.includes("개표 시작")) {
        return `[서울시장 개표상황] ${timePhrase}, 서울시장 선거 개표가 시작됐습니다.`;
      }
      return `[서울시장 개표상황] ${timePhrase}, ${event || item.title} 상황이 전해졌습니다.`;
    }

    const candidates = [...snapshot.candidates].sort((a, b) => b.votes - a.votes);
    const leader = candidates[0];
    const margin = candidates.length > 1 ? leader.votes - candidates[1].votes : null;
    const lead = margin == null
      ? `${leader.candidate_name} 후보가 선두입니다.`
      : margin === 0
        ? `${leader.candidate_name} 후보와 2위 후보가 동률입니다.`
        : `${leader.candidate_name} 후보가 ${formatHeadlineMargin(margin)} 차로 선두입니다.`;
    const rate = Number(snapshot.counted_rate).toString();
    const count = snapshot.counted_rate === 100 ? `최종 개표율 ${rate}%` : `개표율 ${rate}%`;
    const incident = event.includes("역전") && margin != null && margin !== 0
      ? `${leader.candidate_name} 후보가 ${formatHeadlineMargin(margin)} 차로 역전 선두입니다.`
      : event.includes("최종 개표 완료") && margin != null && margin !== 0
        ? `${leader.candidate_name} 후보가 ${formatHeadlineMargin(margin)} 차로 최종 선두입니다.`
        : lead;
    return `[서울시장 개표상황] ${timePhrase}, ${count}, ${incident}`;
  }

  function show(key, label, title, articleId, isPledge) {
    slot.dataset.articleId = articleId || "";
    slot.disabled = !articleId;
    slot.classList.toggle("is-empty", !articleId);
    slot.classList.toggle("is-pledge", Boolean(isPledge));
    kind.textContent = label;
    if (key === shownKey) return;
    shownKey = key;
    const next = document.createElement("strong");
    next.className = "live-headline-title is-entering";
    next.textContent = title;
    const previous = [...viewport.children];
    viewport.append(next);
    void next.offsetWidth;
    next.classList.remove("is-entering");
    for (const old of previous) {
      old.classList.add("is-leaving");
      setTimeout(() => old.remove(), 450);
    }
  }

  function topPledges() {
    const seen = new Set();
    const ranked = liveArticles
      .filter(item => item.article_type === "pledge")
      .sort((a, b) => (statusRank[b.status] || 0) - (statusRank[a.status] || 0));
    const picks = [];
    for (const item of ranked) {
      if (seen.has(item.title)) continue;
      seen.add(item.title);
      picks.push(item);
      if (picks.length === 2) break;
    }
    return picks;
  }

  function inCountGap() {
    return !replayFrames.slice(0, currentStep).some(frame => frame.counted_rate !== null);
  }

  function showPledge() {
    const pledges = topPledges();
    if (!pledges.length) {
      show("no-pledge", "공약", "뉴스룸에서 작성한 공약 기사가 아직 없습니다.", null, true);
      return;
    }
    const item = pledges[pledgeIndex % pledges.length];
    show(item.article_id, "공약", liveArticleTitle(item), item.article_id, true);
  }

  function setPledgeRotation(on) {
    if (on && !pledgeTimer) {
      pledgeTimer = setInterval(() => { pledgeIndex += 1; showPledge(); }, PLEDGE_SWAP_MS);
    } else if (!on && pledgeTimer) {
      clearInterval(pledgeTimer);
      pledgeTimer = null;
    }
  }

  function renderLiveHeadline() {
    if (!currentStep) {
      setPledgeRotation(false);
      show("idle", "대기", "개표 재생을 시작하면 보도실 기사가 표시됩니다.", null, false);
      return;
    }
    if (inCountGap()) {
      setPledgeRotation(true);
      showPledge();
      return;
    }
    setPledgeRotation(false);
    let pick = null;
    for (const item of liveArticles) {
      const step = item.snapshot?.step_id;
      if (item.article_type === "pledge" || !step || step > currentStep) continue;
      if (!pick || step > pick.snapshot.step_id || (step === pick.snapshot.step_id && better(item, pick))) pick = item;
    }
    if (pick) show(pick.article_id, "속보", liveArticleTitle(pick), pick.article_id, false);
    else show(`none-${currentStep}`, "속보", `${currentStep}단계 속보 기사를 뉴스룸에서 작성해 주세요.`, null, false);
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
    renderLiveHeadline();
  }

  const previousRender = render;
  render = function (frame) {
    previousRender(frame);
    const step = frame?.step_id || 0;
    if (step < currentStep || step <= 1) pledgeIndex = 0;
    currentStep = step;
    refreshLiveHeadlines();
  };

  // Articles written in the newsroom show up without waiting for the next stage.
  const previousRefreshEditor = refreshEditorArticles;
  refreshEditorArticles = async function (...args) {
    refreshLiveHeadlines();
    return previousRefreshEditor.apply(this, args);
  };

  slot.addEventListener("click", async () => {
    const articleId = slot.dataset.articleId;
    if (!articleId || busy) return;
    archiveArticleId = articleId;
    openWorkspaceView("library");
    window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      await refreshArchive();
      const selected = await api(`/api/articles/${articleId}`);
      const row = [...byId("article-list").querySelectorAll("tr[data-article-id]")]
        .find(candidate => candidate.dataset.articleId === articleId);
      if (row) row.click();
      else {
        archiveArticleId = articleId;
        renderNewsArticle(selected);
      }
    } catch (error) {
      byId("library-article").replaceChildren(Object.assign(document.createElement("p"), {
        className: "news-empty", textContent: error.message,
      }));
    }
  });

  refreshLiveHeadlines();
})();
