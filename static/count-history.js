const csvUrl = "https://raw.githubusercontent.com/csycmr/team-election-newsroom/main/data/replay/count_timeline.csv?v=ballot-events";
const byId = (id) => document.getElementById(id);
let latestReplayEvent;
let syncReplay;
document.addEventListener("count-replay", (event) => {
  latestReplayEvent = event.detail;
  syncReplay?.(latestReplayEvent);
});
const timestampLabel = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const numberLabel = new Intl.NumberFormat("ko-KR");
const timeBasis = {
  simulated: "시연용 재구성",
  count_observation: "보도 집계",
  publication_time: "기사 송고 시각",
  approximate: "보도 기준 추정 시각",
  reported_event: "보도 사건 시각",
};

function renderTimeline(entries) {
  const axis = byId("count-history-axis");
  const detail = byId("count-history-detail");
  let animation;
  let linked = false;
  const cursor = document.createElement("span");
  cursor.className = "count-history-cursor";
  cursor.setAttribute("aria-hidden", "true");
  cursor.hidden = true;
  axis.append(cursor);
  const startTime = entries[0].time;
  const duration = entries.at(-1).time - startTime;
  const toPercent = (time) => 100 * (time - startTime) / duration;
  const positions = entries.map(entry => toPercent(entry.time));
  const points = entries.map((entry, index) => {
    const point = document.createElement("button");
    point.type = "button";
    point.className = "count-history-point";
    point.classList.toggle("is-incident", entry.counted_rate_pct === "" && entry.event.includes("잠실7동"));
    const smallPoint = entry.timestamp_kst === "2026-06-04T04:55:00+09:00";
    const largePoint = entry.timestamp_kst === "2026-06-04T07:16:00+09:00";
    const position = positions[index];
    const nearNeighbor = [positions[index - 1], positions[index + 1]]
      .some(neighbor => neighbor !== undefined && Math.abs(neighbor - position) < 2.4);
    point.classList.toggle("is-dense", !largePoint && (smallPoint || nearNeighbor));
    point.classList.toggle("is-large", largePoint);
    point.style.left = `${position}%`;
    point.title = `${entry.step_id}단계 · ${timestampLabel.format(entry.time)} · ${entry.event}`;
    point.setAttribute("aria-label", point.title);
    point.addEventListener("click", () => {
      if (linked) return;
      cursor.hidden = true;
      show(index);
      document.dispatchEvent(new CustomEvent("count-history-select", { detail: entry }));
    });
    axis.append(point);
    return point;
  });
  const labelLanes = [];
  for (const entry of entries) {
    const position = toPercent(entry.time);
    const openLane = labelLanes.findIndex(last => position - last >= 4.8);
    const lane = openLane === -1 ? labelLanes.length : openLane;
    labelLanes[lane] = position;
    const label = document.createElement("time");
    const [, month, day, hours, minutes] = entry.timestamp_kst.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    label.className = "count-history-tick";
    label.dateTime = entry.timestamp_kst;
    label.style.left = `${position}%`;
    label.style.setProperty("--label-lane", String(lane));
    const dayLabel = document.createElement("span");
    dayLabel.textContent = `${Number(month)}/${Number(day)}`;
    const clockLabel = document.createElement("span");
    clockLabel.textContent = `${hours}:${minutes}${entry.time_basis === "approximate" ? "쯤" : ""}`;
    label.append(dayLabel, clockLabel);
    axis.append(label);
  }

  axis.style.setProperty("--extra-label-height", `${(labelLanes.length - 1) * 31}px`);

  function show(index) {
    const entry = entries[index];
    points.forEach((point, pointIndex) => point.setAttribute("aria-pressed", String(pointIndex === index)));
    const headline = document.createElement("p");
    const title = document.createElement("strong");
    const eventTitle = entry.time_basis === "simulated" ? "개표 진행" : entry.event;
    title.textContent = `${entry.step_id}단계 · ${timestampLabel.format(entry.time)} · ${eventTitle}`;
    headline.append(title);
    const basis = document.createElement("p");
    basis.className = "count-history-meta";
    basis.textContent = timeBasis[entry.time_basis];
    detail.replaceChildren(headline, basis);
    if (entry.counted_rate_pct) {
      const rate = document.createElement("p");
      rate.className = "count-history-rate";
      rate.textContent = `전체 개표율 ${entry.counted_rate_pct}%`;
      detail.append(rate);
      const validVotes = document.createElement("p");
      validVotes.textContent = entry.counted_valid_votes == null
        ? "집계 유효표 수 미확인"
        : `집계 유효표 ${numberLabel.format(entry.counted_valid_votes)}표`;
      if (entry.counted_valid_votes_basis === "simulation_interpolation") {
        const estimate = document.createElement("small");
        estimate.className = "count-history-meta valid-votes-source";
        estimate.textContent = "시연 데이터 기반 추정";
        validVotes.append(estimate);
      }
      detail.append(validVotes);
      const stats = document.createElement("p");
      stats.textContent = `오세훈 ${numberLabel.format(Number(entry.oh_se_hoon_votes))}표 (${entry.oh_se_hoon_vote_rate_pct}%) · 정원오 ${numberLabel.format(Number(entry.jung_won_oh_votes))}표 (${entry.jung_won_oh_vote_rate_pct}%)`;
      detail.append(stats);
    }
    if (entry.note) {
      const note = document.createElement("p");
      note.className = "dark-muted";
      note.textContent = entry.note;
      detail.append(note);
    }
    [entry.source_url, entry.additional_source_url].forEach((url, linkIndex) => {
      if (!url || !url.startsWith("https://")) return;
      const link = document.createElement("a");
      link.href = url;
      link.textContent = linkIndex === 0 ? `${entry.source_name} ↗` : "최종 집계표 ↗";
      detail.append(link);
    });
  }

  function moveCursor(time) {
    cursor.style.left = `${toPercent(time)}%`;
  }

  syncReplay = ({ kind, frame, next: nextFrame, deadline }) => {
    cancelAnimationFrame(animation);
    if (kind === "stop") linked = false;
    else if (kind === "start" || kind === "frame") linked = true;
    if (kind === "pause" || kind === "stop") return;
    cursor.hidden = false;
    if (kind === "start") {
      show(0);
      moveCursor(startTime);
      return;
    }
    if (!frame) return;
    const from = Date.parse(frame.timestamp_kst);
    const to = nextFrame ? Date.parse(nextFrame.timestamp_kst) : from;
    show(frame.step_id - 1);
    moveCursor(from);
    if (to <= from) return;
    const started = deadline - 5000;
    const tick = (now) => {
      const fraction = Math.max(0, Math.min(1, (now - started) / 5000));
      moveCursor(from + (to - from) * fraction);
      if (fraction < 1) animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
  };

  show(0);
  if (latestReplayEvent) syncReplay(latestReplayEvent);
}

try {
  const entries = await countTimelineData;
  renderTimeline(entries.map(entry => ({ ...entry, time: Date.parse(entry.timestamp_kst) })));
  byId("count-history-status").hidden = true;
  byId("count-history-content").hidden = false;
} catch (error) {
  byId("count-history-status").textContent = "타임라인을 불러오지 못했어요. 아래 GitHub CSV에서 확인할 수 있어요.";
  const link = document.createElement("a");
  link.href = csvUrl;
  link.textContent = " GitHub CSV 열기 ↗";
  byId("count-history-status").append(link);
  console.error(error);
}
