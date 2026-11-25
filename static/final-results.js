const find = (id) => document.getElementById(id);
const formatNumber = new Intl.NumberFormat("ko-KR");
const colors = ["#ed737e", "#679bff", "#f3cd58", "#b896ff", "#f2a875"];
const svgNamespace = "http://www.w3.org/2000/svg";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function candidateRows(names, votes) {
  const total = votes.reduce((sum, value) => sum + value, 0);
  return names.map((name, index) => ({
    name,
    votes: votes[index],
    rate: total ? votes[index] / total * 100 : 0,
    color: colors[index],
  })).sort((a, b) => b.votes - a.votes);
}

function bar(label, value, width, color) {
  const row = element("div", "final-bar");
  const heading = element("div", "final-bar-heading");
  heading.append(element("span", "", label), element("strong", "", value));
  const track = element("div", "track");
  const fill = element("div", "fill");
  fill.style.width = `${width}%`;
  fill.style.backgroundColor = color;
  track.setAttribute("aria-hidden", "true");
  track.append(fill);
  row.append(heading, track);
  return row;
}

function renderResults(data) {
  const select = find("final-district");
  const detail = find("district-detail");
  const methods = find("method-results");
  const districts = data.districts.map((district) => {
    const candidates = candidateRows(data.names, district.votes);
    const [first, second] = candidates;
    return { ...district, candidates, first, gap: first.rate - second.rate };
  });
  const ranked = [...districts].sort((a, b) => a.gap - b.gap);
  const maxGap = ranked.at(-1).gap;
  const buttons = new Map();
  const paths = new Map();
  const map = document.createElementNS(svgNamespace, "svg");
  map.setAttribute("viewBox", data.viewBox.join(" "));
  map.setAttribute("role", "group");
  map.setAttribute("aria-label", "서울 자치구별 1위 후보 지도");

  const selectionOutline = document.createElementNS(svgNamespace, "path");
  selectionOutline.setAttribute("class", "district-selection-outline");
  selectionOutline.setAttribute("aria-hidden", "true");

  function showDistrict(district) {
    select.value = district.name;
    selectionOutline.setAttribute("d", district.outline);
    for (const [name, button] of buttons) {
      button.setAttribute("aria-pressed", String(name === district.name));
      paths.get(name).setAttribute("aria-pressed", String(name === district.name));
    }
    detail.replaceChildren(
      element("h4", "", `${district.name} · 후보별 최종 득표`),
      ...district.candidates.map(({ name, votes, rate, color }) =>
        bar(name, `${formatNumber.format(votes)}표 · ${rate.toFixed(2)}%`, rate, color)),
    );
    methods.replaceChildren(...district.methods.map((votes, index) => {
      const panel = element("div", "method-card");
      const total = votes.reduce((sum, value) => sum + value, 0);
      panel.append(
        element("h4", "", `${district.name} · ${data.types[index]}`),
        element("p", "dark-muted", `유효표 ${formatNumber.format(total)}표`),
        ...candidateRows(data.names, votes).map(({ name, rate, color }) =>
          bar(name, total ? `${rate.toFixed(2)}%` : "—", rate, color)),
      );
      return panel;
    }));
  }

  for (const district of districts) {
    const option = element("option", "", district.name);
    option.value = district.name;
    select.append(option);

    const path = document.createElementNS(svgNamespace, "path");
    path.setAttribute("d", district.outline);
    path.setAttribute("fill", district.first.color);
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("tabindex", "0");
    path.setAttribute("role", "button");
    const label = `${district.name}, 1위 ${district.first.name}`;
    path.setAttribute("aria-label", label);
    const title = document.createElementNS(svgNamespace, "title");
    title.textContent = label;
    path.append(title);
    path.addEventListener("click", () => showDistrict(district));
    path.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showDistrict(district);
      }
    });
    map.append(path);
    paths.set(district.name, path);
  }

  const ranking = find("district-ranking");
  for (const district of ranked) {
    const [first, second] = district.candidates;
    const label = `${district.name} · ${first.name} 앞섬`;
    const value = `${district.gap.toFixed(3)}%p · ${formatNumber.format(first.votes - second.votes)}표`;
    const button = element("button", "district-rank-button");
    button.type = "button";
    button.append(bar(label, value, maxGap ? district.gap / maxGap * 100 : 0, first.color));
    button.addEventListener("click", () => showDistrict(district));
    const item = element("li");
    item.append(button);
    ranking.append(item);
    buttons.set(district.name, button);
  }

  const legend = element("ul", "district-legend");
  for (const [name, color] of new Map(districts.map(({ first }) => [first.name, first.color]))) {
    const item = element("li");
    const swatch = element("span");
    swatch.style.backgroundColor = color;
    item.append(swatch, document.createTextNode(`${name} 1위`));
    legend.append(item);
  }
  map.append(selectionOutline);
  find("district-map").append(map, legend);

  for (const pledge of data.pledges) {
    const grid = element("ol", "pledge-grid");
    grid.append(...pledge.titles.map((title) => element("li", "", title)));
    const column = element("section", "pledge-column method-card");
    column.append(element("h4", "", `${pledge.name} · ${pledge.party}`), grid);
    find("pledge-results").append(column);
  }

  select.addEventListener("change", () => {
    const district = districts.find(({ name }) => name === select.value);
    if (district) showDistrict(district);
  });
  showDistrict(ranked[0]);
}

try {
  const response = await fetch("/static/final-results.json?v=candidate-comparison");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  renderResults(await response.json());
  find("final-results-content").hidden = false;
  find("final-results-status").hidden = true;
} catch (error) {
  find("final-results-status").textContent = "최종 개표 자료를 불러오지 못했어요. 새로고침해 주세요.";
  console.error("Final election results", error);
}
