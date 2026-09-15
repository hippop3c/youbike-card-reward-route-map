(() => {
  "use strict";

  const DATA = window.CARD_REWARD_ROUTE_MANIFEST;
  const PAGE_SIZE = 50;
  const COLORS = { full: "#ef7d35", empty: "#159b73", both: "#7656b6" };
  const state = {
    selectedDates: new Set(),
    query: "",
    page: 1,
    selectedCard: null,
    selectedRows: [],
    selectionToken: 0
  };
  const shardCache = new Map();
  const shardPromises = new Map();
  const routeVisuals = new Map();
  let shardLoadQueue = Promise.resolve();
  let currentPageCards = new Map();
  let searchTimer = 0;
  let toastTimer = 0;

  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat("zh-TW");
  const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

  const map = L.map("map", { preferCanvas: true, zoomControl: true, minZoom: 8 }).setView([25.04, 121.52], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
  const lineLayer = L.layerGroup().addTo(map);
  const arrowLayer = L.layerGroup().addTo(map);
  const endpointLayer = L.layerGroup().addTo(map);

  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").classList.add("show");
    toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2400);
  }

  function hideLoading() {
    $("loading").classList.add("hidden");
  }

  function setMapMessage(message, visible = true) {
    $("mapMessage").textContent = message;
    $("mapMessage").classList.toggle("hidden", !visible);
  }

  function shortDate(value) {
    const [year, month, day] = value.split("-");
    return `${year}/${Number(month)}/${Number(day)}`;
  }

  function buildDates() {
    const fragment = document.createDocumentFragment();
    let priorMonth = "";
    DATA.dates.forEach((row, index) => {
      const month = row[0].slice(0, 7);
      if (month !== priorMonth) {
        const heading = document.createElement("h3");
        heading.textContent = `${Number(month.slice(0, 4))} 年 ${Number(month.slice(5))} 月`;
        fragment.appendChild(heading);
        priorMonth = month;
      }
      const label = document.createElement("label");
      if (row[2] === "假日") label.className = "holiday";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = String(index);
      input.checked = true;
      const text = document.createElement("span");
      text.textContent = `${Number(row[0].slice(8))} 日 ${row[1]}`;
      label.append(input, text);
      fragment.appendChild(label);
      state.selectedDates.add(index);
    });
    $("dateGrid").replaceChildren(fragment);
    updateDateSummary();
  }

  function checkedDateIndices() {
    return [...$("dateGrid").querySelectorAll('input[type="checkbox"]:checked')].map((input) => Number(input.value));
  }

  function syncSelectedDates() {
    state.selectedDates = new Set(checkedDateIndices());
    updateDateSummary();
    if (state.selectedCard) renderSelectedRoutes();
  }

  function updateDateSummary() {
    const selected = [...state.selectedDates].sort((a, b) => a - b);
    if (!selected.length) {
      $("dateButtonText").textContent = "尚未選擇日期";
      $("selectionSummary").textContent = "0 日";
      return;
    }
    if (selected.length === DATA.dates.length) {
      $("dateButtonText").textContent = `全部 ${selected.length} 日`;
    } else if (selected.length <= 2) {
      $("dateButtonText").textContent = selected.map((index) => shortDate(DATA.dates[index][0])).join("、");
    } else {
      $("dateButtonText").textContent = `已選 ${selected.length} 日`;
    }
    const first = DATA.dates[selected[0]][0];
    const last = DATA.dates[selected[selected.length - 1]][0];
    $("selectionSummary").textContent = `${shortDate(first)}–${shortDate(last)}，共 ${selected.length} 日`;
  }

  function visibleCards() {
    const query = state.query.trim().toUpperCase().replace(/[^0-9A-F]/g, "");
    if (!query) return DATA.cards;
    return DATA.cards.filter((card) => card[1].includes(query) || card[0].toUpperCase().includes(query));
  }

  function cardAlias(cardId) {
    return cardId.slice(0, 6).toUpperCase();
  }

  function renderCardList() {
    const cards = visibleCards();
    const pages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), pages);
    const start = (state.page - 1) * PAGE_SIZE;
    const rows = cards.slice(start, start + PAGE_SIZE);
    currentPageCards = new Map(rows.map((card) => [card[0], card]));
    $("cardCount").textContent = fmt.format(cards.length);
    $("cardList").innerHTML = rows.map((card) => {
      const active = state.selectedCard?.[0] === card[0] ? " active" : "";
      return `<button class="card-row${active}" type="button" data-card-id="${card[0]}"><span class="card-id"><strong>末五碼 ${safe(card[1])}</strong><span>匿名 ${cardAlias(card[0])} · ${fmt.format(card[4])} 個獎勵日 · ${fmt.format(card[5])} 條路線</span></span><span class="card-counts"><i class="full">滿 ${fmt.format(card[2])}</i><i class="empty">空 ${fmt.format(card[3])}</i></span></button>`;
    }).join("") || '<div class="empty-state" style="padding:30px 10px"><p>找不到符合的卡片</p></div>';
    $("pageText").textContent = `${fmt.format(state.page)} / ${fmt.format(pages)}`;
    $("prevPage").disabled = state.page <= 1;
    $("nextPage").disabled = state.page >= pages;
  }

  function loadShard(shard) {
    if (shardCache.has(shard)) return Promise.resolve(shardCache.get(shard));
    if (shardPromises.has(shard)) return shardPromises.get(shard);
    const task = () => new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `data/routes-${shard}.js?v=${encodeURIComponent(DATA.version)}`;
        script.dataset.shard = shard;
        script.onload = () => {
          const payload = window.CARD_REWARD_ROUTE_SHARD;
          if (!payload || payload.shard !== shard || !payload.cards) {
            reject(new Error("路線分片格式錯誤"));
            return;
          }
          shardCache.set(shard, payload.cards);
          resolve(payload.cards);
        };
        script.onerror = () => reject(new Error("無法載入卡片路線"));
        document.head.appendChild(script);
      });
    const promise = shardLoadQueue.then(task, task).finally(() => shardPromises.delete(shard));
    shardLoadQueue = promise.catch(() => undefined);
    shardPromises.set(shard, promise);
    return promise;
  }

  async function selectCard(card) {
    state.selectedCard = card;
    state.selectedRows = [];
    const token = ++state.selectionToken;
    renderCardList();
    $("routeEmpty").classList.add("hidden");
    $("routeContent").classList.remove("hidden");
    $("selectedSuffix").textContent = `卡號末五碼 ${card[1]}`;
    $("selectedAlias").textContent = `匿名 ${cardAlias(card[0])}`;
    $("routeBody").innerHTML = '<tr><td colspan="4" style="text-align:center;color:#66778a">載入路線中…</td></tr>';
    setMapMessage("載入這張卡片的獎勵路線…");
    lineLayer.clearLayers();
    arrowLayer.clearLayers();
    endpointLayer.clearLayers();
    try {
      const cards = await loadShard(card[0].slice(0, 2));
      if (token !== state.selectionToken) return;
      state.selectedRows = cards[card[0]] || [];
      renderSelectedRoutes();
    } catch (error) {
      console.error(error);
      if (token !== state.selectionToken) return;
      $("routeBody").innerHTML = '<tr><td colspan="4" style="text-align:center;color:#b84c3a">路線載入失敗</td></tr>';
      setMapMessage("路線載入失敗");
      toast(error.message);
    }
  }

  function routeColor(route) {
    if (route.full > 0 && route.empty > 0) return COLORS.both;
    return route.full > 0 ? COLORS.full : COLORS.empty;
  }

  function stationName(index) {
    return DATA.stations[index]?.[0] || "未辨識場站";
  }

  function aggregateSelectedRoutes() {
    const routes = new Map();
    let full = 0;
    let empty = 0;
    for (const row of state.selectedRows) {
      if (!state.selectedDates.has(row[0])) continue;
      const key = `${row[1]}:${row[2]}`;
      const current = routes.get(key) || { key, origin: row[1], destination: row[2], full: 0, empty: 0, days: new Set() };
      current.full += Number(row[3] || 0);
      current.empty += Number(row[4] || 0);
      current.days.add(row[0]);
      routes.set(key, current);
      full += Number(row[3] || 0);
      empty += Number(row[4] || 0);
    }
    const list = [...routes.values()].map((route) => ({ ...route, total: route.full + route.empty })).sort((a, b) => b.total - a.total || b.full - a.full || a.key.localeCompare(b.key));
    return { list, full, empty };
  }

  function routePopup(route) {
    return `<div class="popup-route"><strong>${safe(stationName(route.origin))} → ${safe(stationName(route.destination))}</strong><span><em>滿借獎勵</em><b>${fmt.format(route.full)}</b></span><span><em>空還獎勵</em><b>${fmt.format(route.empty)}</b></span><span><em>累積獎勵</em><b>${fmt.format(route.total)}</b></span><span><em>發生日</em><b>${fmt.format(route.days.size)} 日</b></span></div>`;
  }

  function validCoordinate(station) {
    return station && Number.isFinite(Number(station[3])) && Number.isFinite(Number(station[4]));
  }

  function arrowAngle(origin, destination) {
    const latitudeDelta = Number(destination[3]) - Number(origin[3]);
    const longitudeDelta = (Number(destination[4]) - Number(origin[4])) * Math.cos((Number(origin[3]) + Number(destination[3])) * Math.PI / 360);
    return Math.atan2(-latitudeDelta, longitudeDelta) * 180 / Math.PI;
  }

  function drawMap(routes) {
    lineLayer.clearLayers();
    arrowLayer.clearLayers();
    endpointLayer.clearLayers();
    routeVisuals.clear();
    const bounds = [];
    const endpoints = new Map();
    let mapped = 0;

    for (const route of routes) {
      const origin = DATA.stations[route.origin];
      const destination = DATA.stations[route.destination];
      if (!validCoordinate(origin) || !validCoordinate(destination)) continue;
      const start = [Number(origin[3]), Number(origin[4])];
      const end = [Number(destination[3]), Number(destination[4])];
      const color = routeColor(route);
      let visual;
      if (start[0] === end[0] && start[1] === end[1]) {
        visual = L.circle(start, { radius: 70, color, weight: 3, fillColor: color, fillOpacity: .24 });
      } else {
        visual = L.polyline([start, end], { color, weight: Math.min(10, 2.5 + Math.sqrt(route.total) * 1.35), opacity: .72, lineCap: "round" });
        const middle = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
        const angle = arrowAngle(origin, destination);
        L.marker(middle, {
          interactive: false,
          icon: L.divIcon({ className: "", html: `<div class="direction-arrow" style="transform:rotate(${angle}deg)">➜</div>`, iconSize: [26, 26], iconAnchor: [13, 13] })
        }).addTo(arrowLayer);
      }
      visual.bindPopup(routePopup(route)).addTo(lineLayer);
      routeVisuals.set(route.key, { visual, bounds: [start, end] });
      bounds.push(start, end);
      mapped += 1;
      const originRole = endpoints.get(route.origin) || { origin: false, destination: false, total: 0 };
      originRole.origin = true;
      originRole.total += route.total;
      endpoints.set(route.origin, originRole);
      const destinationRole = endpoints.get(route.destination) || { origin: false, destination: false, total: 0 };
      destinationRole.destination = true;
      destinationRole.total += route.total;
      endpoints.set(route.destination, destinationRole);
    }

    for (const [stationIndex, role] of endpoints) {
      const station = DATA.stations[stationIndex];
      if (!validCoordinate(station)) continue;
      const roleClass = role.origin && role.destination ? "both" : role.origin ? "origin" : "destination";
      const label = role.origin && role.destination ? "起訖" : role.origin ? "起" : "訖";
      const marker = L.marker([Number(station[3]), Number(station[4])], {
        icon: L.divIcon({ className: "", html: `<div class="endpoint-marker ${roleClass}">${label}</div>`, iconSize: [31, 31], iconAnchor: [15, 15] }),
        riseOnHover: true
      });
      marker.bindPopup(`<div class="popup-route"><strong>${safe(station[0])}</strong><span><em>${role.origin && role.destination ? "起站與訖站" : role.origin ? "起站" : "訖站"}</em><b>${fmt.format(role.total)} 次</b></span></div>`).addTo(endpointLayer);
    }

    if (bounds.length) map.fitBounds(bounds, { padding: [46, 46], maxZoom: 15 });
    setMapMessage(routes.length ? `顯示 ${fmt.format(mapped)} / ${fmt.format(routes.length)} 條可定位路線` : "所選日期沒有獎勵路線", true);
  }

  function renderSelectedRoutes() {
    if (!state.selectedCard) return;
    const { list, full, empty } = aggregateSelectedRoutes();
    $("fullTotal").textContent = fmt.format(full);
    $("emptyTotal").textContent = fmt.format(empty);
    $("rewardTotal").textContent = fmt.format(full + empty);
    $("routeCount").textContent = fmt.format(list.length);
    $("routeScope").textContent = `${fmt.format(state.selectedDates.size)} 個選取日期`;
    $("routeBody").innerHTML = list.map((route) => {
      const origin = DATA.stations[route.origin];
      const destination = DATA.stations[route.destination];
      const subtitle = `${safe(origin?.[1] || "")} ${safe(origin?.[2] || "")} → ${safe(destination?.[1] || "")} ${safe(destination?.[2] || "")} · ${fmt.format(route.days.size)} 日`;
      return `<tr><td><button class="route-link" type="button" data-route-key="${route.key}">${safe(stationName(route.origin))} → ${safe(stationName(route.destination))}<small>${subtitle}</small></button></td><td>${fmt.format(route.full)}</td><td>${fmt.format(route.empty)}</td><td><strong>${fmt.format(route.total)}</strong></td></tr>`;
    }).join("") || '<tr><td colspan="4" style="padding:28px 10px;text-align:center;color:#66778a">所選日期沒有獎勵紀錄</td></tr>';
    drawMap(list);
  }

  function bindEvents() {
    $("dateButton").addEventListener("click", () => {
      const open = $("datePopover").classList.toggle("hidden");
      $("dateButton").setAttribute("aria-expanded", String(!open));
    });
    $("dateGrid").addEventListener("change", syncSelectedDates);
    $("datePopover").addEventListener("click", (event) => {
      const action = event.target.dataset.dateAction;
      if (!action) return;
      $("dateGrid").querySelectorAll('input[type="checkbox"]').forEach((input) => {
        const dayType = DATA.dates[Number(input.value)][2];
        input.checked = action === "all" || (action === "weekday" && dayType === "平日") || (action === "holiday" && dayType === "假日");
      });
      syncSelectedDates();
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".date-control")) {
        $("datePopover").classList.add("hidden");
        $("dateButton").setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        $("datePopover").classList.add("hidden");
        $("dateButton").setAttribute("aria-expanded", "false");
      }
    });
    $("cardSearch").addEventListener("input", (event) => {
      state.query = event.target.value;
      state.page = 1;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderCardList, 140);
    });
    $("prevPage").addEventListener("click", () => { state.page -= 1; renderCardList(); $("cardList").scrollTop = 0; });
    $("nextPage").addEventListener("click", () => { state.page += 1; renderCardList(); $("cardList").scrollTop = 0; });
    $("cardList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-card-id]");
      if (!button) return;
      const card = currentPageCards.get(button.dataset.cardId);
      if (card) void selectCard(card);
    });
    $("routeBody").addEventListener("click", (event) => {
      const button = event.target.closest("[data-route-key]");
      if (!button) return;
      const target = routeVisuals.get(button.dataset.routeKey);
      if (!target) return toast("這條路線缺少可定位的場站座標");
      map.fitBounds(target.bounds, { padding: [90, 90], maxZoom: 16 });
      target.visual.openPopup();
    });
  }

  function currentView() {
    return {
      dates: [...state.selectedDates].sort((a, b) => a - b).map((index) => DATA.dates[index][0]),
      cardSearch: state.query,
      selectedCard: state.selectedCard ? { suffix: state.selectedCard[1], anonymousAlias: cardAlias(state.selectedCard[0]) } : null,
      totals: state.selectedCard ? {
        full: Number($("fullTotal").textContent.replaceAll(",", "") || 0),
        empty: Number($("emptyTotal").textContent.replaceAll(",", "") || 0),
        rewards: Number($("rewardTotal").textContent.replaceAll(",", "") || 0),
        routes: Number($("routeCount").textContent.replaceAll(",", "") || 0)
      } : null
    };
  }

  function registerWebMcp() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const reportError = (error) => console.warn("WebMCP registration failed", error);
    const register = (tool) => {
      try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(reportError); }
      catch (error) { reportError(error); }
    };
    register({
      name: "read_card_route_view",
      title: "讀取卡號路線分析畫面",
      description: "讀取目前勾選日期、卡號搜尋、已選匿名卡片與累積獎勵結果。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => currentView()
    });
    register({
      name: "configure_card_route_view",
      title: "設定卡號路線分析畫面",
      description: "批次設定獎勵日期，並可用卡號後五碼與匿名代碼選取一張卡片。",
      inputSchema: {
        type: "object",
        properties: {
          dates: { type: "array", items: { type: "string", pattern: "^2026-(07|08|09)-[0-3][0-9]$" } },
          cardSuffix: { type: "string", pattern: "^[0-9]{5}$" },
          anonymousAlias: { type: "string", pattern: "^[0-9A-Fa-f]{6}$" }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("輸入必須是物件");
        if (input.dates) {
          const wanted = new Set(input.dates);
          const known = new Set(DATA.dates.map((row) => row[0]));
          if ([...wanted].some((date) => !known.has(date))) throw new Error("包含資料範圍外的日期");
          $("dateGrid").querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
            checkbox.checked = wanted.has(DATA.dates[Number(checkbox.value)][0]);
          });
          syncSelectedDates();
        }
        if (input.cardSuffix || input.anonymousAlias) {
          const suffix = input.cardSuffix || "";
          const alias = String(input.anonymousAlias || "").toUpperCase();
          const matches = DATA.cards.filter((card) => (!suffix || card[1] === suffix) && (!alias || cardAlias(card[0]) === alias));
          if (!matches.length) throw new Error("找不到指定卡片");
          if (matches.length > 1) throw new Error("後五碼對應多張卡，請同時提供匿名代碼");
          state.query = suffix || alias;
          $("cardSearch").value = state.query;
          state.page = 1;
          renderCardList();
          await selectCard(matches[0]);
        }
        return currentView();
      }
    });
    window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
  }

  function init() {
    if (!DATA?.cards?.length || !DATA?.dates?.length || !DATA?.stations?.length) {
      $("loadingText").textContent = "找不到卡片路線資料";
      return;
    }
    buildDates();
    renderCardList();
    bindEvents();
    registerWebMcp();
    hideLoading();
  }

  init();
})();
