const csvUrl = "https://raw.githubusercontent.com/csycmr/team-election-newsroom/main/data/replay/count_timeline.csv";
const byId = (id) => document.getElementById(id);
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
  interpolated: "시연용 보간",
  count_observation: "보도 집계",
  publication_time: "기사 송고 시각",
  approximate: "보도 기준 추정 시각",
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
  if (entries.length < 2 || entries.some((entry, index) =>
    !Number.isFinite(entry.time) || !(entry.time_basis in timeBasis) ||
    (index > 0 && entry.time <= entries[index - 1].time))) {
    throw new Error("Invalid timeline");
  }
  return entries;
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
  const points = entries.map((entry, index) => {
    const point = document.createElement("button");
    point.type = "button";
    point.className = "count-history-point";
    const simulated = entry.time_basis === "interpolated";
    point.classList.toggle("is-interpolated", simulated);
    point.textContent = simulated ? "◇" : "●";
    point.style.left = `${100 * (entry.time - first.time) / (last.time - first.time)}%`;
    point.title = `${timestampLabel.format(entry.time)} · ${entry.event}`;
    point.setAttribute("aria-label", point.title);
    point.addEventListener("click", () => {
      stop();
      show(index);
    });
    axis.append(point);
    return point;
  });
  const reported = entries.filter((entry) => entry.time_basis !== "interpolated");
  reported.forEach((entry, index) => {
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
    prev.disabled = index === 0;
    next.disabled = index === entries.length - 1;
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
      link.textContent = entry.time_basis === "interpolated"
        ? (linkIndex === 0 ? "이전 기준 기록 ↗" : "다음 기준 기록 ↗")
        : (linkIndex === 0 ? `${entry.source_name} ↗` : "최종 집계표 ↗");
      detail.append(link);
    });
  }

  function stop() {
    clearInterval(timer);
    timer = undefined;
    play.textContent = "타임라인 재생";
  }

  play.addEventListener("click", () => {
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
  prev.addEventListener("click", () => { stop(); show(current - 1); });
  next.addEventListener("click", () => { stop(); show(current + 1); });
  show(0);
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
