const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let DATA = { tools: [], users: [], teams: [], skills: [], apps: [], workflows: [] };
let state = {
  view: "tools",
  sort: "threads",
  dir: "desc",
  window: "7d",
  hideCentaur: true,
};

const TOOL_COLS = [
  { key: "rank",     label: "#",          num: true,  noSort: true, w: "3.5%",  cls: "" },
  { key: "tool",     label: "Tool",       num: false, w: "13%",     cls: "tool-name", hasIcon: true },
  { key: "calls",    label: "Calls",      num: true,  w: "6%" },
  { key: "threads",  label: "Sessions",    num: true,  w: "7%" },
  { key: "users",    label: "Users",      num: true,  w: "6%" },
  { key: "methods_count", label: "Methods", num: true, w: "6%", cls: "col-methods" },
  { key: "calls_per_thread", label: "C/S", num: true, w: "5%", cls: "col-cpt" },
  { key: "method1",  label: "#1 Method",  num: false, w: "12%", noSort: true, cls: "method" },
  { key: "method2",  label: "#2 Method",  num: false, w: "12%", noSort: true, cls: "method col-method2" },
  { key: "method3",  label: "#3 Method",  num: false, w: "10.5%", noSort: true, cls: "method col-method3" },
  { key: "first_seen", label: "First",    num: false, w: "10%",  cls: "col-first" },
  { key: "last_seen",  label: "Last",     num: false, w: "10%",  cls: "col-last" },
];

const USER_COLS = [
  { key: "rank",     label: "#",       num: true,  noSort: true, w: "3.5%" },
  { key: "name",     label: "Name",    num: false, w: "15%",     cls: "user-name", hasPfp: true },
  { key: "team",     label: "Team",    num: false, w: "12%",     cls: "col-team" },
  { key: "calls",    label: "Calls",   num: true,  w: "7%" },
  { key: "threads",  label: "Sessions", num: true,  w: "7.5%" },
  { key: "tools",    label: "Tools",   num: true,  w: "5.5%" },
  { key: "calls_per_thread", label: "C/S", num: true, w: "5%", cls: "col-cpt" },
  { key: "tool1",    label: "#1 Tool", num: false, w: "15%", noSort: true, cls: "method" },
  { key: "tool2",    label: "#2 Tool", num: false, w: "15%", noSort: true, cls: "method col-method2" },
  { key: "tool3",    label: "#3 Tool", num: false, w: "15%", noSort: true, cls: "method col-method3 col-tool3" },
];

const TEAM_COLS = [
  { key: "rank",        label: "#",        num: true,  noSort: true, w: "3.5%" },
  { key: "team",        label: "Team",     num: false, w: "13%",     cls: "tool-name", hasEmoji: true },
  { key: "members",     label: "Members",  num: true,  w: "7%" },
  { key: "calls",       label: "Calls",    num: true,  w: "7%" },
  { key: "threads",     label: "Sessions",  num: true,  w: "7%" },
  { key: "calls_per_member", label: "C/M", num: true,  w: "5.5%" },
  { key: "threads_per_member", label: "S/M", num: true, w: "5.5%" },
  { key: "member_list", label: "Members",  num: false, w: "51.5%", noSort: true, cls: "member-list" },
];

const SKILL_COLS = [
  { key: "rank",     label: "#",        num: true,  noSort: true, w: "3.5%" },
  { key: "skill",    label: "Skill",    num: false, w: "19%",     cls: "tool-name", hasSkillEmoji: true },
  { key: "calls",    label: "Calls",    num: true,  w: "6%" },
  { key: "threads",  label: "Sessions",  num: true,  w: "6%" },
  { key: "users",    label: "Users",    num: true,  w: "6%" },
  { key: "calls_per_thread", label: "C/S", num: true, w: "5%", cls: "col-cpt" },
  { key: "user1",    label: "#1 User",  num: false, w: "11%", noSort: true, cls: "method" },
  { key: "user2",    label: "#2 User",  num: false, w: "11%", noSort: true, cls: "method col-method2" },
  { key: "user3",    label: "#3 User",  num: false, w: "11.5%", noSort: true, cls: "method col-method3" },
  { key: "first_seen", label: "First",  num: false, w: "10.5%",  cls: "col-first" },
  { key: "last_seen",  label: "Last",   num: false, w: "10.5%",  cls: "col-last" },
];

const WORKFLOW_COLS = [
  { key: "rank",         label: "#",          num: true,  noSort: true, w: "3.5%" },
  { key: "workflow",     label: "Workflow",   num: false, w: "21%",     cls: "tool-name", hasWorkflowEmoji: true },
  { key: "total",        label: "Runs",       num: true,  w: "10%" },
  { key: "completed",    label: "Completed",  num: true,  w: "11%" },
  { key: "failed",       label: "Failed",     num: true,  w: "10%" },
  { key: "success_rate", label: "Success%",   num: true,  w: "11%" },
  { key: "avg_duration_s", label: "Avg (s)",  num: true,  w: "11%" },
  { key: "first_seen",   label: "First",      num: false, w: "11%",  cls: "col-first" },
  { key: "last_seen",    label: "Last",       num: false, w: "11.5%",  cls: "col-last" },
];

const APP_COLS = [
  { key: "rank",          label: "#",         num: true,  noSort: true, w: "3.5%" },
  { key: "app",           label: "App",       num: false, w: "21%",     cls: "tool-name", hasAppLink: true, hasAppEmoji: true },
  { key: "status",        label: "Status",    num: false, w: "11%",     cls: "col-status" },
  { key: "views",         label: "Views",     num: true,  w: "12.5%" },
  { key: "requests",      label: "Requests",  num: true,  w: "13%" },
  { key: "visitors",      label: "Visitors",  num: true,  w: "13%" },
  { key: "errors",        label: "Errors",    num: true,  w: "13%" },
  { key: "error_rate",    label: "Err%",      num: true,  w: "13%",     cls: "col-cpt" },
];

const DEFAULT_SORT = { tools: "threads", skills: "threads", users: "threads", teams: "threads_per_member", workflows: "total", apps: "views" };

function fmt(n) {
  if (n == null) return "\u2014";
  return Number(n).toLocaleString();
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function getCols() {
  if (state.view === "tools") return TOOL_COLS;
  if (state.view === "skills") return SKILL_COLS;
  if (state.view === "teams") return TEAM_COLS;
  if (state.view === "workflows") return WORKFLOW_COLS;
  if (state.view === "apps") return APP_COLS;
  return USER_COLS;
}

function getRows() {
  let src;
  if (state.view === "tools") src = DATA.tools;
  else if (state.view === "skills") src = DATA.skills;
  else if (state.view === "teams") src = DATA.teams;
  else if (state.view === "workflows") src = DATA.workflows;
  else if (state.view === "apps") src = DATA.apps;
  else src = DATA.users;

  let rows = [...(src || [])];

  if (state.hideCentaur && (state.view === "teams" || state.view === "users")) {
    rows = rows.filter(r => (r.team || r.name) !== "Centaur Internal");
  }

  const key = state.sort;
  const mult = state.dir === "desc" ? -1 : 1;
  rows.sort((a, b) => {
    let av = a[key], bv = b[key];
    if (typeof av === "string") return mult * av.localeCompare(bv);
    return mult * ((av ?? 0) - (bv ?? 0));
  });

  return rows;
}

function renderHead() {
  const cols = getCols();
  const ths = cols.map((c) => {
    const sorted = state.sort === c.key;
    const arrow = sorted ? (state.dir === "desc" ? "\u25BC" : "\u25B2") : "";
    const cls = [
      c.num ? "num" : "",
      c.noSort ? "no-sort" : "",
      sorted ? "sorted" : "",
      c.cls || "",
    ].filter(Boolean).join(" ");
    return `<th class="${cls}" data-col="${c.key}"${c.w ? ` style="width:${c.w}"` : ""}>
      ${c.label}${arrow ? `<span class="sort-arrow">${arrow}</span>` : ""}
    </th>`;
  }).join("");
  $("#thead").innerHTML = `<tr>${ths}</tr>`;
}

const PH = `<span class="team-emoji placeholder-icon">?</span>`;

function renderTeamCell(r) {
  const icon = r.team === "Centaur Internal"
    ? `<img class="pfp" src="centaur.png" loading="lazy" alt="">`
    : `<span class="team-emoji">${r.emoji || PH}</span>`;
  return `<td class="tool-name"><span class="tool-identity">${icon}${escapeHtml(r.team)}</span></td>`;
}

function renderTeamBadge(r) {
  return `<td class="col-team"><span class="tool-identity"><span class="team-emoji">${r.team_emoji || PH}</span>${escapeHtml(r.team || "")}</span></td>`;
}

function renderToolCell(r) {
  const icon = r.icon
    ? `<img class="tool-icon" src="${escapeHtml(r.icon)}" loading="lazy" alt="" onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('afterbegin','${PH.replace(/"/g, '&quot;')}')">`
    : PH;
  return `<td class="tool-name"><span class="tool-identity">${icon}${escapeHtml(r.tool)}</span></td>`;
}

function renderUserCell(r) {
  const pfp = r.pfp
    ? `<img class="pfp" src="${escapeHtml(r.pfp)}" loading="lazy" alt="" onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('afterbegin','${PH.replace(/"/g, '&quot;')}')">`
    : PH;
  const handle = r.handle && r.handle !== "\u2014" ? `<span class="handle">@${escapeHtml(r.handle)}</span>` : "";
  return `<td class="user-name"><span class="user-identity">${pfp}<span><span class="user-realname">${escapeHtml(r.name)}</span>${handle}</span></span></td>`;
}

function renderBody() {
  const cols = getCols();
  const rows = getRows();
  $("#row-count").textContent = `${rows.length} ${state.view}`;

  const html = rows.map((r, i) => {
    const tds = cols.map((c) => {
      if (c.hasWorkflowEmoji) return `<td class="tool-name"><span class="tool-identity"><span class="team-emoji">${r.emoji || PH}</span>${escapeHtml(r.workflow)}</span></td>`;
      if (c.hasAppLink) return `<td class="tool-name"><span class="tool-identity"><span class="team-emoji">${r.emoji || PH}</span><a href="https://svc-ai.dayno.xyz/apps/${escapeHtml(r.app)}/" target="_blank" class="app-link">${escapeHtml(r.app)}</a></span></td>`;
      if (c.hasSkillEmoji) return `<td class="tool-name"><span class="tool-identity"><span class="team-emoji">${r.emoji || PH}</span>${escapeHtml(r.skill)}</span></td>`;
      if (c.hasIcon && state.view === "tools") return renderToolCell(r);
      if (c.hasPfp && state.view === "users") return renderUserCell(r);
      if (c.hasEmoji) return renderTeamCell(r);
      if (c.key === "team" && state.view === "users") return renderTeamBadge(r);
      const cls = [c.num ? "num" : "", c.cls || ""].filter(Boolean).join(" ");
      let val;
      if (c.key === "rank") {
        val = i + 1;
      } else if (c.key === "first_seen" && r.first_url) {
        val = `<a href="${escapeHtml(r.first_url)}" target="_blank" class="date-link">${r.first_seen}</a>`;
      } else if (c.key === "last_seen" && r.last_url) {
        val = `<a href="${escapeHtml(r.last_url)}" target="_blank" class="date-link">${r.last_seen}</a>`;
      } else if (c.num) {
        val = fmt(r[c.key]);
      } else {
        val = r[c.key] || "\u2014";
        if (c.cls && c.cls.includes("method") && val && val.includes(" (")) {
          const m = val.match(/^(.+)\s+\((.+)\)$/);
          if (m) val = `<span class="ranked-name">${escapeHtml(m[1])}</span><span class="ranked-count">(${m[2]})</span>`;
        }
      }
      return `<td class="${cls}">${val}</td>`;
    }).join("");
    return `<tr>${tds}</tr>`;
  }).join("");

  $("#tbody").innerHTML = html;
}

function render() {
  renderHead();
  renderBody();
  syncUrl();
  const toggle = $("#centaur-toggle");
  toggle.style.display = (state.view === "teams" || state.view === "users") ? "" : "none";
}

const BASE_PATH = "/apps/usage";
const VIEWS = ["tools", "skills", "workflows", "apps", "teams", "users"];

function viewPath(view) {
  return `${BASE_PATH}/${view}`;
}

function syncUrl(push) {
  const p = new URLSearchParams();
  if (state.sort && state.sort !== DEFAULT_SORT[state.view]) p.set("sort", state.sort);
  if (state.dir !== "desc") p.set("dir", state.dir);
  if (state.window !== "7d") p.set("window", state.window);
  const qs = p.toString();
  const url = viewPath(state.view) + (qs ? `?${qs}` : "");
  if (push) {
    history.pushState(null, "", url);
  } else {
    history.replaceState(null, "", url);
  }
}

function loadStateFromUrl() {
  const path = location.pathname.replace(/\/$/, "");
  const segment = path.split("/").pop();
  if (VIEWS.includes(segment)) {
    state.view = segment;
  }
  const p = new URLSearchParams(location.search);
  if (p.has("sort")) state.sort = p.get("sort");
  else state.sort = DEFAULT_SORT[state.view] || "calls";
  if (p.has("dir")) state.dir = p.get("dir");
  else state.dir = "desc";
  if (p.has("window")) state.window = p.get("window");
  else state.window = "7d";
}

function syncPills(name, value) {
  $$(`input[name="${name}"]`).forEach((r) => {
    const checked = r.value === String(value);
    r.checked = checked;
    r.closest(".radio-pill").classList.toggle("active", checked);
  });
}

function syncAllPills() {
  syncPills("view", state.view);
  syncPills("window", state.window);
}

function init() {
  if (localStorage.getItem("theme") === "light") {
    document.documentElement.classList.add("light");
  }

  loadStateFromUrl();

  const cleanPath = location.pathname.replace(/\/$/, "");
  if (cleanPath === BASE_PATH) {
    history.replaceState(null, "", viewPath("tools"));
  }

  let WINDOWED = null;
  let PFP_MAP = {};

  Promise.all([
    fetch("api/stats").then((r) => r.ok ? r.json() : Promise.reject("api")).catch(() => null),
    fetch("data.json").then((r) => r.json()).catch(() => null),
  ]).then(([live, static_]) => {
    // Build pfp map from static data
    if (static_ && static_.users) {
      for (const u of static_.users) { if (u.pfp) PFP_MAP[u.handle] = u.pfp; }
    }

    // Handle windowed vs flat data
    if (live && live.windows) {
      WINDOWED = live.windows;
    } else {
      // Flat data (old format or static fallback)
      const d = live || static_ || {};
      WINDOWED = { all: d, "30d": d, "7d": d, "1d": d };
    }

    applyWindow();
    syncAllPills();
    render();
  });

  function applyWindow() {
    const w = WINDOWED ? WINDOWED[state.window] || WINDOWED["all"] : {};
    DATA = {
      tools: w.tools || [],
      skills: w.skills || [],
      users: w.users || [],
      teams: w.teams || [],
      apps: w.apps || [],
      workflows: w.workflows || [],
    };
    // Merge pfps
    for (const u of DATA.users) { if (!u.pfp && PFP_MAP[u.handle]) u.pfp = PFP_MAP[u.handle]; }
    // Full team roster (independent of activity window)
    const TEAM_ROSTER = {
      "I&R": ["Georgios Konstantopoulos", "Matt Huang", "Dan Robinson", "Frankie xyz", "Alana Palmedo", "Arjun Balaji", "Alpin Yukseloglu", "Ricardo de Arruda", "Storm Slivkoff"],
      "Finance": ["Lindsay Slocum", "Pam Tholen", "Jordan Qualls", "Spencer Fluetsch", "Asher Sedlin", "Vidhu Pinnamaraju", "Caleb Onofrei", "Alex Ehlers"],
      "Admin": ["Elena Page", "Amy Sinclair", "Gracie Globerman", "Karina Berry", "Holly Morgan-Winsdale", "Nicki Lardieri", "Liz Khussein", "Flor Romero"],
      "Engineering": ["Brandon Wong", "Chris Mann", "Katie Shia", "Chentai Kao", "Shogo Nakai"],
      "Legal": ["Katie Biber", "Stefan Schropp", "Ben Hinshaw", "Alex Popescu"],
      "Policy": ["Dominique Little", "Alex Grieve", "Justin Slaughter", "Madison Parker"],
      "Operations": ["Jordan Kong", "Trevor Holmgren", "Ishan Goyal"],
      "Communications": ["David Swain", "Chris Kraeuter", "Veit Moeller"],
      "Events": ["Josie McGuinn", "Tony Coppola", "Karina Ruiz Garcia"],
      "Talent": ["Chris Shu", "Dan McCarthy"],
      "Trading": ["Rama Somayajula"],
      "Centaur Internal": [],
    };
    const TEAM_EMOJIS = {
      "I&R": "\ud83d\udd2c", "Finance": "\ud83d\udcb0", "Admin": "\ud83d\udcc5",
      "Policy": "\ud83c\udfdb", "Communications": "\ud83d\udce2", "Legal": "\u2696\ufe0f",
      "Trading": "\ud83d\udcc8", "Events": "\ud83c\udf89", "Engineering": "\ud83d\udd27",
      "Talent": "\ud83d\udc65", "Operations": "\u2699\ufe0f", "Centaur Internal": "\ud83e\udd16",
    };
    // Ensure all teams appear with full roster, override member counts
    const teamMap = new Map(DATA.teams.map(t => [t.team, t]));
    DATA.teams = Object.entries(TEAM_ROSTER).map(([name, members]) => {
      const existing = teamMap.get(name) || { calls: 0, threads: 0 };
      return {
        team: name, members: members.length, calls: existing.calls, threads: existing.threads,
        calls_per_member: 0, threads_per_member: 0,
        member_list: members.sort().join(", "), emoji: TEAM_EMOJIS[name] || "",
      };
    });
    DATA.users = DATA.users.filter(u => u.team !== "Other");
    // Compute per-member metrics using full roster size
    for (const t of DATA.teams) {
      t.calls_per_member = t.members > 0 ? Math.round(t.calls / t.members * 10) / 10 : 0;
      t.threads_per_member = t.members > 0 ? Math.round(t.threads / t.members * 10) / 10 : 0;
    }
  }

  $$('input[name="view"]').forEach((r) => {
    r.addEventListener("change", () => {
      switchView(r.value);
    });
  });

  $$('input[name="window"]').forEach((r) => {
    r.addEventListener("change", () => {
      state.window = r.value;
      syncPills("window", r.value);
      applyWindow();
      render();
    });
  });

  $("#show-centaur").addEventListener("change", (e) => {
    state.hideCentaur = !e.target.checked;
    render();
  });

  document.addEventListener("click", (e) => {
    const th = e.target.closest("th[data-col]");
    if (!th || th.classList.contains("no-sort")) return;
    const col = th.dataset.col;
    if (state.sort === col) {
      state.dir = state.dir === "desc" ? "asc" : "desc";
    } else {
      state.sort = col;
      state.dir = "desc";
    }
    render();
  });

  function switchView(view) {
    state.view = view;
    state.sort = DEFAULT_SORT[view] || "calls";
    state.dir = "desc";
    syncPills("view", state.view);
    renderHead();
    renderBody();
    syncUrl(true);
  }

  document.addEventListener("keydown", (e) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (e.key === "d" && !typing) {
      document.documentElement.classList.toggle("light");
      localStorage.setItem("theme", document.documentElement.classList.contains("light") ? "light" : "dark");
    }
    if (e.key === "[" && !typing) {
      const idx = VIEWS.indexOf(state.view);
      if (idx > 0) switchView(VIEWS[idx - 1]);
    }
    if (e.key === "]" && !typing) {
      const idx = VIEWS.indexOf(state.view);
      if (idx < VIEWS.length - 1) switchView(VIEWS[idx + 1]);
    }
  });

  window.addEventListener("popstate", () => {
    loadStateFromUrl();
    syncAllPills();
    renderHead();
    renderBody();
  });
}

init();
