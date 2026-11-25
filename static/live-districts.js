// 자치구별 개표 현황 (재생 연동).
//
// Only the final district totals exist, not per-district counts over time, so each
// replay stage is reconstructed for the demo:
//   - each district's count progress follows the citywide count rate, with a fixed
//     per-district pace so districts don't all move in lockstep;
//   - candidate shares lean toward the citywide shares reported at that stage and
//     converge on the real final district result at 100%.
// The panel is labelled 시연용 추정 for that reason.

const find = (id) => document.getElementById(id);
const svgNamespace = "http://www.w3.org/2000/svg";
const OH = "오세훈";
const JUNG = "정원오";
const OH_COLOR = "#ed737e";
const JUNG_COLOR = "#679bff";
const MIN_ROW_HEIGHT = 14;
const STACKED_ROW_HEIGHT = 18;

function pace(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return 0.78 + (hash % 1000) / 1000 * 0.5; // exponent between 0.78 and 1.28
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function load() {
  const [finals, timeline] = await Promise.all([
    fetch("/static/final-results.json?v=candidate-comparison").then((r) => r.json()),
    fetch("/api/count-timeline").then((r) => r.json()),
  ]);
  return { finals, timeline };
}

function setup({ finals, timeline }) {
  const ohIndex = finals.names.indexOf(OH);
  const jungIndex = finals.names.indexOf(JUNG);
  const cityTotals = finals.names.map((_, index) =>
    finals.districts.reduce((sum, district) => sum + district.votes[index], 0));
  const cityAll = cityTotals.reduce((a, b) => a + b, 0);
  const cityFinalRate = (index) => cityTotals[index] / cityAll * 100;

  const map = document.createElementNS(svgNamespace, "svg");
  map.setAttribute("viewBox", finals.viewBox.join(" "));
  map.setAttribute("role", "img");
  map.setAttribute("aria-label", "서울 자치구별 개표 진행 지도");
  const list = find("live-district-bars");
  let rowHeight = STACKED_ROW_HEIGHT;
  let order = [];

  const districts = finals.districts.map((district) => {
    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", district.outline);
    path.setAttribute("fill-rule", "evenodd");
    const title = document.createElementNS(svgNamespace, "title");
    path.append(title);
    map.append(path);

    const row = element("li", "live-district-row");
    const name = element("span", "live-district-name", district.name);
    const track = element("span", "live-district-track");
    const oh = element("span", "live-district-oh");
    const jung = element("span", "live-district-jung");
    track.append(oh, jung);
    const value = element("span", "live-district-value", "—");
    row.append(name, track, value);
    list.append(row);
    return { ...district, pace: pace(district.name), path, title, row, oh, jung, value };
  });
  find("live-district-map").append(map);

  function lastCountedFrame(frame) {
    if (!frame) return null;
    return timeline
      .filter((entry) => entry.step_id <= frame.step_id && entry.counted_rate !== null)
      .at(-1) || null;
  }

  // Make the bar block exactly as tall as the map when the two sit side by side.
  function fitRows() {
    const grid = find("live-districts-content");
    const side = grid && getComputedStyle(grid).gridTemplateColumns.split(" ").length > 1;
    const head = list.previousElementSibling;
    if (side) {
      const available = map.getBoundingClientRect().height - (head ? head.offsetHeight : 0) - 8;
      rowHeight = Math.max(MIN_ROW_HEIGHT, available / districts.length);
    } else {
      rowHeight = STACKED_ROW_HEIGHT;
    }
    list.style.height = `${districts.length * rowHeight}px`;
    list.style.setProperty("--row-height", `${rowHeight}px`);
    order.forEach((entry, index) => {
      entry.row.style.transform = `translateY(${index * rowHeight}px)`;
    });
  }

  function update(frame) {
    const counted = lastCountedFrame(frame);
    const cityRate = counted?.counted_rate ?? 0;
    const reported = new Map((counted?.candidates || []).map((c) => [c.candidate_name, c.vote_rate]));
    const lean = (index) => {
      const now = reported.get(finals.names[index]);
      return now ? now / cityFinalRate(index) : 1;
    };

    const rows = districts.map((district) => {
      const progress = cityRate <= 0 ? 0 : cityRate >= 100 ? 100 : 100 * (cityRate / 100) ** district.pace;
      const share = progress / 100;
      const votes = district.votes.map((finalVotes, index) =>
        finalVotes * share * (1 + (lean(index) - 1) * (1 - share)));
      const total = votes.reduce((a, b) => a + b, 0);
      const ohRate = total ? votes[ohIndex] / total * 100 : 0;
      const jungRate = total ? votes[jungIndex] / total * 100 : 0;
      return { district, progress, ohRate, jungRate, margin: ohRate - jungRate };
    });

    const sorted = rows
      .slice()
      .sort((a, b) => b.margin - a.margin || a.district.name.localeCompare(b.district.name, "ko"));
    order = sorted.map((entry) => entry.district);
    sorted
      .forEach((entry, index) => {
        const { district, progress, ohRate, jungRate } = entry;
        district.row.style.transform = `translateY(${index * rowHeight}px)`;
        const started = progress > 0;
        const pair = ohRate + jungRate || 1;
        district.oh.style.width = started ? `${ohRate / pair * 100}%` : "0%";
        district.jung.style.width = started ? `${jungRate / pair * 100}%` : "0%";
        district.value.textContent = started ? `${progress.toFixed(1)}%` : "—";
        district.row.title = started
          ? `${district.name} · 개표 ${progress.toFixed(1)}% · ${OH} ${ohRate.toFixed(2)}% · ${JUNG} ${jungRate.toFixed(2)}%`
          : `${district.name} · 개표 전`;

        const leader = ohRate >= jungRate ? OH_COLOR : JUNG_COLOR;
        district.path.setAttribute("fill", started ? leader : "#1c2733");
        district.path.setAttribute("fill-opacity", started ? String(0.3 + 0.7 * progress / 100) : "1");
        district.title.textContent = district.row.title;
      });

    find("live-district-status").textContent = counted
      ? `${counted.step_id}단계 · 서울 전체 개표율 ${counted.counted_rate_pct ?? counted.counted_rate}% 기준`
      : "개표 재생을 시작하면 자치구별 개표가 채워집니다.";
  }


  document.addEventListener("count-replay", (event) => {
    const { kind, frame } = event.detail;
    if (kind === "start") update(null);
    else if (frame) update(frame);
  });
  document.addEventListener("count-history-select", (event) => update(event.detail));
  update(null);
  return fitRows;
}

try {
  const fitRows = setup(await load());
  find("live-districts-content").hidden = false;
  fitRows();
  window.addEventListener("resize", fitRows);
  if (window.ResizeObserver) new ResizeObserver(fitRows).observe(find("live-district-map"));
} catch (error) {
  find("live-district-status").textContent = "자치구 개표 자료를 불러오지 못했어요.";
  console.error("Live district results", error);
}
