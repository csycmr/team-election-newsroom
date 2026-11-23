const csvUrl = "https://raw.githubusercontent.com/csycmr/team-election-newsroom/main/data/replay/count_timeline.csv";
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
  count_observation: "보도 집계",
  publication_time: "기사 송고 시각",
  approximate: "보도 기준 추정 시각",
  reported_event: "보도 사건 시각",
};

function readTimeline(csv) {
  const lines = csv.trim().split(/\r?\n/);
  const headers = lines.shift().split(",");
  const entries = lines.map((line) => {
    const fields = Array.from(line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g), ([, field]) =>
      field.startsWith('"') ? field.slice(1, -1).replaceAll('""', '"') : field);
    if (fields.length !== headers.length) throw new Error("Invalid CSV row");
    const entry = Object.fromEntries(headers.map((header, index) => [header, fields[index]]));
    return { ...entry, time: Date.parse(entry.timestamp_kst) };
  });
  const reported = entries.filter((entry) => Object.hasOwn(timeBasis, entry.time_basis));
  if (reported.length < 2 || reported.some((entry, index) =>
    !Number.isFinite(entry.time) || (index > 0 && entry.time <= reported[index - 1].time))) {
    throw new Error("Invalid timeline");
  }
  return reported;
}

function renderTimeline(entries) {
  const axis = byId("count-history-axis");
  const detail = byId("count-history-detail");
  const play = byId("count-history-play");
  const prev = byId("count-history-prev");
  const next = byId("count-history-next");
  const first = entries[0];
  const last = entries.at(-1);
  let current = 0;
  let timer;
  let animation;
  let linked = false;
  const cursor = document.createElement("span");
  cursor.className = "count-history-cursor";
  cursor.setAttribute("aria-hidden", "true");
  cursor.hidden = true;
  axis.append(cursor);
  const toPercent = (time) => 100 * (time - first.time) / (last.time - first.time);
  const points = entries.map((entry, index) => {
    const point = document.createElement("button");
    point.type = "button";
    point.className = "count-history-point";
    point.style.left = `${100 * (entry.time - first.time) / (last.time - first.time)}%`;
    point.title = `${timestampLabel.format(entry.time)} · ${entry.event}`;
    point.setAttribute("aria-label", point.title);
    point.addEventListener("click", () => {
      if (linked) return;
      cursor.hidden = true;
      stop();
      show(index);
    });
    axis.append(point);
    return point;
  });
  entries.forEach((entry, index) => {
    const label = document.createElement("time");
    const [, month, day, hours, minutes] = entry.timestamp_kst.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    label.className = "count-history-tick";
    if (entry === first) label.classList.add("is-first");
    if (entry === last) label.classList.add("is-last");
    label.dateTime = entry.timestamp_kst;
    label.style.left = `${100 * (entry.time - first.time) / (last.time - first.time)}%`;
    label.style.setProperty("--tick-lane", String(index % 2));
    label.textContent = `${Number(month)}/${Number(day)} ${hours}:${minutes}${entry.time_basis === "approximate" ? "쯤" : ""}`;
    axis.append(label);
  });

  function show(index) {
    current = index;
    const entry = entries[index];
    points.forEach((point, pointIndex) => point.setAttribute("aria-pressed", String(pointIndex === index)));
    prev.disabled = linked || index === 0;
    next.disabled = linked || index === entries.length - 1;
    const headline = document.createElement("p");
    const title = document.createElement("strong");
    title.textContent = `${timestampLabel.format(entry.time)} · ${entry.event} · ${timeBasis[entry.time_basis]}`;
    headline.append(title);
    detail.replaceChildren(headline);
    if (entry.counted_rate_pct) {
      const stats = document.createElement("p");
      stats.textContent = `개표율 ${entry.counted_rate_pct}% · 오세훈 ${numberLabel.format(Number(entry.oh_se_hoon_votes))}표 (${entry.oh_se_hoon_vote_rate_pct}%) · 정원오 ${numberLabel.format(Number(entry.jung_won_oh_votes))}표 (${entry.jung_won_oh_vote_rate_pct}%)`;
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

  function stop() {
    clearInterval(timer);
    timer = undefined;
    play.textContent = "타임라인 재생";
  }

  const rateAnchors = [first, ...entries.slice(1).filter((entry) => entry.counted_rate_pct !== "")];

  function timeAtRate(rate) {
    const upper = rateAnchors.findIndex((entry) => Number(entry.counted_rate_pct) >= rate);
    if (upper <= 0) return upper === 0 ? first.time : last.time;
    const before = rateAnchors[upper - 1];
    const after = rateAnchors[upper];
    const fraction = (rate - Number(before.counted_rate_pct)) /
      (Number(after.counted_rate_pct) - Number(before.counted_rate_pct));
    return before.time + fraction * (after.time - before.time);
  }

  function moveCursor(time) {
    cursor.style.left = `${toPercent(time)}%`;
    const index = entries.findLastIndex((entry) => entry.time <= time);
    if (index >= 0 && index !== current) show(index);
  }

  syncReplay = ({ kind, frame, next: nextFrame, deadline }) => {
    cancelAnimationFrame(animation);
    if (kind === "stop") linked = false;
    else if (kind === "start" || kind === "frame") linked = true;
    play.disabled = linked;
    prev.disabled = linked || current === 0;
    next.disabled = linked || current === entries.length - 1;
    if (kind === "pause" || kind === "stop") return;
    stop();
    cursor.hidden = false;
    if (kind === "start") {
      show(0);
      moveCursor(first.time);
      return;
    }
    if (!frame) return;
    const from = timeAtRate(frame.counted_rate);
    const to = nextFrame ? timeAtRate(nextFrame.counted_rate) : from;
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

  play.addEventListener("click", () => {
    cursor.hidden = true;
    if (timer !== undefined) {
      stop();
      return;
    }
    if (current === entries.length - 1) show(0);
    play.textContent = "일시 정지";
    timer = setInterval(() => {
      show(current + 1);
      if (current === entries.length - 1) stop();
    }, 900);
  });
  prev.addEventListener("click", () => { cursor.hidden = true; stop(); show(current - 1); });
  next.addEventListener("click", () => { cursor.hidden = true; stop(); show(current + 1); });
  show(0);
  if (latestReplayEvent) syncReplay(latestReplayEvent);
}

try {
  const response = await fetch(csvUrl, { cache: "no-cache" });
  if (!response.ok) throw new Error(`CSV HTTP ${response.status}`);
  renderTimeline(readTimeline(await response.text()));
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
