// no-mistakes cockpit: read-only observability over the state database of the
// machine its pane props name (props().machine; nothing: this computer).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import {
  checking, closeOverlay, exec, props, readTextFile, run, settings, spaces, theme, window,
} from "herdr";
import {
  age, base, clip, fmtDuration, fmtTokens, gateStep, label, lineColor, nowStep,
  parseFindings, pickRun, pickStep, runInvocations, runList,
  runRounds, runSteps, severityColor, shortSha, statusColor, stepLogPath,
} from "./model.js";

const LOG_LINES = 500;
const ACTIVE = new Set(["running", "pending"]);
const OPEN = new Set(["running", "fixing"]);

export default class NoMistakes extends View {
  init(_props, cx) {

    // The space's machine comes from props(); read it lazily, since props()
    // is the accessor and init's first argument is not the props object.
    this.machine = undefined;
    this.runs = [];
    this.run = null;
    this.steps = [];
    this.invocations = [];
    this.rounds = [];
    this.selected = null;
    this.selectedStep = null;
    this.tab = "logs";
    this.filter = "needs";
    this.error = null;
    this.loading = true;
    this.width = 0;
    this.intentOpen = false;
    this.logPath = null;
    this.logLines = [];
    this.logTotal = 0;
    this.logFollow = true;
    this.logErrors = false;
    this.logLoadedFor = null;
    this.logLoadedStatus = null;
    this.logLastCount = 0;
    this.detailToken = 0;
    this.busyRuns = false;
    this.busyDetail = false;
    this.busyLog = false;
    this.runsScroll = ScrollHandle.new();
    this.logScroll = ScrollHandle.new();
    if (checking()) return;
    this.refreshRuns(cx);
    cx.timer.every(5000, (cx) => this.refreshRuns(cx));
    cx.timer.every(2000, (cx) => this.refreshDetail(cx));
    cx.timer.every(1200, (cx) => this.refreshLog(cx));
  }

  // props().machine: the space's machine; null means this computer.
  target() {
    if (this.machine === undefined) this.machine = props()?.machine ?? null;
    return this.machine;
  }

  // ---- data -------------------------------------------------------------

  refreshRuns(cx) {
    if (this.busyRuns) return;
    this.busyRuns = true;
    cx.spawn(async (cx) => {
      try {
        const rows = await runList(this.target());
        this.runs = rows;
        this.loading = false;
        this.error = null;
        if (this.selected) this.run = rows.find((r) => r.id === this.selected) || this.run;
        if (!this.selected || !rows.some((r) => r.id === this.selected)) {
          const pick = pickRun(rows);
          if (pick) {
            this.selected = pick.id;
            this.run = pick;
            this.clearDetail();
            this.refreshDetail(cx);
            this.revealSelectedRun();
          }
        }
      } catch (e) {
        this.loading = false;
        this.error = String(e?.message || e);
      } finally {
        this.busyRuns = false;
        cx.notify();
      }
    });
  }

  clearDetail() {
    this.steps = [];
    this.invocations = [];
    this.rounds = [];
    this.selectedStep = null;
    this.logPath = null;
    this.logLines = [];
    this.logTotal = 0;
    this.logLoadedFor = null;
    this.logLoadedStatus = null;
    this.logLastCount = 0;
  }

  refreshDetail(cx) {
    if (!this.selected || this.busyDetail) return;
    const id = this.selected;
    const token = ++this.detailToken;
    this.busyDetail = true;
    cx.spawn(async (cx) => {
      try {
        const on = this.target();
        const [steps, invocations, rounds] = await Promise.all([
          runSteps(id, on), runInvocations(id, on), runRounds(id, on),
        ]);
        if (this.detailToken !== token || this.selected !== id) return;
        this.steps = steps;
        this.invocations = invocations;
        this.rounds = rounds;
        this.run = this.runs.find((r) => r.id === id) || this.run;
        const step = pickStep(steps, this.selectedStep);
        this.selectedStep = step?.step_name || null;
        const logPath = await stepLog(step, id, on);
        if (this.detailToken !== token || this.selected !== id) return;
        this.logPath = logPath;
      } catch (e) {
        if (this.detailToken === token) this.error = String(e?.message || e);
      } finally {
        this.busyDetail = false;
        cx.notify();
      }
    });
  }

  refreshLog(cx) {
    if (this.busyLog || this.tab !== "logs" || !this.logPath || !this.selectedStep) return;
    const step = this.steps.find((s) => s.step_name === this.selectedStep);
    if (!step) return;
    const path = this.logPath;
    const status = step.status;
    const active = OPEN.has(status);
    if (!active && this.logLoadedFor === path && this.logLoadedStatus === status) return;
    const stepName = step.step_name;
    this.busyLog = true;
    cx.spawn(async (cx) => {
      try {
        const on = this.target();
        const text = await readTextFile(path, on ? { on } : {});
        if (this.tab !== "logs" || this.selectedStep !== stepName || this.logPath !== path) return;
        const all = String(text || "").split("\n");
        this.logTotal = all.length;
        this.logLines = all.slice(-LOG_LINES);
        this.logLoadedFor = path;
        this.logLoadedStatus = status;
        const n = this.visibleLog().length;
        if (this.logFollow && n > this.logLastCount) this.logScroll.scroll_to_item(n - 1);
        this.logLastCount = n;
      } catch (e) {
        this.logLines = [`Cannot read ${path}: ${e?.message || e}`];
        this.logTotal = 0;
      } finally {
        this.busyLog = false;
        cx.notify();
      }
    });
  }

  // ---- actions ----------------------------------------------------------

  selectRun(id, cx) {
    if (this.selected === id) return;
    this.selected = id;
    this.run = this.runs.find((r) => r.id === id) || null;
    this.clearDetail();
    this.detailToken++;
    this.busyDetail = false;
    this.refreshDetail(cx);
    this.revealSelectedRun();
    cx.notify();
  }

  selectStep(name, cx) {
    const step = this.steps.find((s) => s.step_name === name);
    if (!step) return;
    this.selectedStep = name;
    this.logPath = step.log_path || null;
    this.logLines = [];
    this.logTotal = 0;
    this.logLoadedFor = null;
    this.logLoadedStatus = null;
    this.logLastCount = 0;
    if (!step.log_path) {
      const on = this.target();
      cx.spawn(async (cx) => {
        const path = await stepLog(step, this.selected, on);
        if (this.selectedStep !== name) return;
        this.logPath = path;
        cx.notify();
      });
    }
    if (this.tab === "logs") this.refreshLog(cx);
    cx.notify();
  }

  setTab(tab, cx) {
    this.tab = tab;
    if (tab === "logs") this.refreshLog(cx);
    cx.notify();
  }

  // A run's pipeline lives on its branch, in the repo's own checkout or a
  // linked worktree; a bare `no-mistakes` started elsewhere opens Setup for the
  // branch checked out there. Name the run, and start it in the branch's
  // checkout. `git worktree list` is the exact source: a space's folder and
  // branch describe only its first terminal, and a worktree space can report
  // no branch at all when that terminal sits outside the repo.
  async openTui(cx) {
    const r = this.run;
    if (!r) return;
    const on = this.target();
    const checkout = await branchCheckout(r.working_path, r.branch, on);
    const space = spaces().find((s) => (s.machine ?? null) === (on ?? null)
      && s.folder === checkout);
    const args = {
      name: "no-mistakes",
      folder: checkout,
      argv: ["no-mistakes", "attach", "--run", r.id],
      focus: true,
    };
    if (space) args.space = space.id;
    run("tab.new", args);
  }

  openUrl(url) {
    if (!url) return;
    const platform = window()?.platform;
    const cmd = platform === "macos" ? "open" : platform === "windows" ? "cmd" : "xdg-open";
    const args = platform === "windows" ? ["/c", "start", "", url] : [url];
    exec(cmd, args).catch(() => {});
  }

  scrollLogBottom() {
    const n = this.visibleLog().length;
    if (n) this.logScroll.scroll_to_item(n - 1);
  }

  visibleLog() {
    if (!this.logErrors) return this.logLines;
    return this.logLines.filter((line) =>
      /panic|fatal|\bFAIL\b|error|failed|exited .*error|exit(ed)? .*[1-9]/i.test(line));
  }

  filteredRuns() {
    const list = this.filter === "needs" ? this.runs.filter((r) =>
      r.waiting || r.status === "handed_off" || r.status === "failed")
      : this.filter === "active" ? this.runs.filter((r) => ACTIVE.has(r.status))
      : this.runs;
    return [...list].sort((a, b) => String(base(a.working_path)).localeCompare(String(base(b.working_path)))
      || Number(b.created_at) - Number(a.created_at));
  }

  revealSelectedRun() {
    if (!this.runs.length || !this.runsScroll) return;
    let repo = null;
    let index = 0;
    for (const r of this.filteredRuns()) {
      const name = base(r.working_path);
      if (name !== repo) {
        repo = name;
        if (r.id === this.selected) {
          this.runsScroll.scroll_to_item(index);
          return;
        }
        index++;
      }
      if (r.id === this.selected) {
        this.runsScroll.scroll_to_item(index);
        return;
      }
      index++;
    }
  }

  now() {
    return nowStep(this.steps);
  }

  displayStatus() {
    const gate = gateStep(this.steps);
    if (gate) return "awaiting approval";
    if (this.run?.waiting) return "awaiting approval";
    return label(this.run?.status);
  }

  displayColor(t) {
    const gate = gateStep(this.steps);
    if (gate || this.run?.waiting) return t.blocked;
    return statusColor(t, this.run?.status);
  }

  // ---- small components -------------------------------------------------

  dot(color, size = 6) {
    return div().w(size).h(size).rounded(size / 2).flex_none().bg(color);
  }

  chip(t, text, color) {
    return h_flex().h(22).flex_none().px(8).gap(6).items_center().rounded(5)
      .bg(t.surface).border_1().border_color(t.border)
      .child(this.dot(color, 6))
      .child(div().text_size(10).text_color(color).child(text));
  }

  button(t, id, text, onClick) {
    return h_flex().id(id).h(26).flex_none().px(10).rounded(6).items_center()
      .border_1().border_color(t.border).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => onClick(cx))
      .child(div().text_size(11).text_color(t.muted).child(text));
  }

  // A tab pane closes with its tab; a floating window needs its own way out.
  closeButton(t) {
    return h_flex().id("nm-close").w(26).h(26).flex_none().items_center().justify_center()
      .rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => closeOverlay(props().overlay))
      .child(div().text_size(14).text_color(t.muted).child("×"));
  }

  // ---- render -----------------------------------------------------------

  render(cx) {
    const t = theme();
    return v_flex().id("nm-root").size_full().min_h(0)
      .bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => {
        if (Math.abs((this.width || 0) - size.width) > 1) {
          this.width = size.width;
          cx.notify();
        }
      })
      .child(this.topBar(t))
      .when(Boolean(this.error), (el) => el.child(h_flex().flex_none().h(28).px(14).gap(8).items_center()
        .border_b(1).border_color(t.ansi1)
        .child(div().text_size(11).text_color(t.ansi1).truncate().child(this.error))))
      .child(h_flex().flex_1().min_h(0).items_start()
        .child(this.runRail(t, cx))
        .child(this.center(t, cx))
        .when(this.width >= 980, (el) => el.child(this.rightRail(t, cx))));
  }

  topBar(t) {
    const r = this.run;
    const on = this.target();
    return h_flex().h(46).flex_none().px(14).gap(10).items_center()
      .border_b(1).border_color(t.border)
      .child(div().font_semibold().child(on ? `no-mistakes · ${on}` : "no-mistakes"))
      .when(Boolean(r), (el) => el
        .child(div().text_size(11).text_color(t.muted).child(base(r.working_path)))
        .child(div().max_w(360).min_w(0).truncate().text_size(12).child(r.branch))
        .child(this.chip(t, this.displayStatus(), this.displayColor(t)))
        .child(div().flex_1())
        .child(div().text_size(10).text_color(t.dim).child(`${this.steps.length} steps`))
        .when(ACTIVE.has(r.status), (el2) => el2.child(this.button(t, "top-tui", "Open TUI", (cx) => this.openTui(cx)))))
      .when(!r, (el) => el.child(div().flex_1()))
      .when(Boolean(props()?.overlay), (el) => el.child(this.closeButton(t)));
  }

  runRail(t, cx) {
    const filters = [["needs", "Needs me"], ["active", "Active"], ["all", "All"]];
    const runs = this.filteredRuns();
    return v_flex().w(264).flex_none().h_full().min_h(0).border_r(1).border_color(t.border)
      .child(h_flex().h(40).flex_none().px(12).gap(14).items_center().border_b(1).border_color(t.border)
        .children(filters.map(([key, text]) => div().id(`filter-${key}`).text_size(11).cursor_pointer()
          .text_color(this.filter === key ? t.accent : t.muted)
          .on_click((_e, cx) => { this.filter = key; this.revealSelectedRun(); cx.notify(); })
          .child(text))))
      .child(v_flex().id("nm-runs").flex_1().min_h(0).overflow_y_scrollbar()
        .track_scroll(this.runsScroll).p(6).gap(2)
        .children(this.runGroups(t, runs, cx))
        .when(!runs.length, (el) => el.child(div().p(12).text_size(11).text_color(t.dim)
          .child(this.loading ? "Loading runs…" : this.runs.length ? "Nothing in this filter" : "No runs found"))))
      .child(h_flex().h(32).flex_none().px(12).items_center().border_t(1).border_color(t.border)
        .child(div().text_size(10).text_color(t.dim)
          .child(`${this.runs.length} runs · ${new Set(this.runs.map((r) => r.working_path)).size} repos`)));
  }

  runGroups(t, runs, cx) {
    const out = [];
    let repo = null;
    runs.forEach((r, i) => {
      const name = base(r.working_path);
      if (name !== repo) {
        repo = name;
        out.push(h_flex().id(`repo-${i}`).h(22).flex_none().px(9).items_center()
          .border_b(1).border_color(t.border)
          .child(div().text_size(9).text_color(t.dim).truncate().child(name)));
      }
      out.push(this.runRow(t, r, cx));
    });
    return out;
  }

  runRow(t, r, cx) {
    const selected = r.id === this.selected;
    const waiting = Boolean(r.waiting);
    const color = waiting ? t.blocked : statusColor(t, r.status);
    return v_flex().id(`run-${r.id}`).flex_none().px(9).py(6).gap(2).rounded(7)
      .bg(selected ? t.selected : t.background)
      .when(selected, (el) => el.border_1().border_color(t.accent))
      .cursor_pointer().hover((s) => s.bg(selected ? t.selected : t.hover))
      .on_click((_e, cx) => this.selectRun(r.id, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).text_size(12).truncate().child(r.branch))
        .child(div().text_size(10).text_color(t.dim).child(age(r.created_at))))
      .child(h_flex().gap(6).items_center()
        .child(this.dot(color, 6))
        .child(div().text_size(10).text_color(color).child(waiting ? "awaiting approval" : label(r.status)))
        .child(div().flex_1())
        .when(Boolean(r.pr_state) && r.pr_state !== "none", (el) => el
          .child(div().text_size(10).text_color(t.dim).child(r.pr_state))));
  }

  center(t, cx) {
    const r = this.run;
    if (!r) {
      return v_flex().flex_1().h_full().min_w(0).items_center().justify_center().gap(6)
        .child(div().text_size(12).text_color(t.muted)
          .child(this.loading ? "Loading no-mistakes runs…" : this.runs.length ? "Select a run" : "No no-mistakes runs found"))
        .child(div().text_size(11).text_color(t.dim)
          .child(this.target()
            ? `Reads ~/.no-mistakes/state.sqlite on ${this.target()}; nothing is written.`
            : "Reads ~/.no-mistakes/state.sqlite; nothing is written."));
    }
    return v_flex().flex_1().h_full().min_w(0).min_h(0).p(14).gap(11)
      .child(this.nowCard(t))
      .child(this.intentBlock(t, r))
      .child(this.timeline(t, cx))
      .child(this.tabs(t, cx))
      .child(this.tabBody(t, cx));
  }

  nowCard(t) {
    const r = this.run;
    const step = this.now();
    const color = step ? statusColor(t, step.status) : this.displayColor(t);
    const elapsed = step?.duration_ms != null
      ? Number(step.duration_ms)
      : step?.started_at ? (Date.now() / 1000 - step.started_at) * 1000 : null;
    const done = this.steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
    const pct = this.steps.length ? Math.round((done / this.steps.length) * 100) : 0;
    return v_flex().flex_none().rounded(8).border_1().border_color(t.border).p(11).gap(7).bg(t.surface)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(9).text_color(t.dim).child("NOW"))
        .child(step && OPEN.has(step.status) ? div().w(7).h(7).rounded(4).bg(color).loop("opacity", { from: 0.35, to: 1, period: 1200 }) : this.dot(color, 7))
        .child(div().text_size(12).text_color(color)
          .child(step ? `${step.step_name} · ${label(step.status)}` : label(r.status)))
        .child(div().flex_1())
        .when(elapsed != null, (el) => el.child(div().text_size(11).text_color(t.muted).child(fmtDuration(elapsed)))))
      .child(h_flex().gap(12).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted)
          .child(step?.last_activity || (r.awaiting_agent_since ? `waiting ${age(r.awaiting_agent_since)}` : "no activity recorded")))
        .child(div().text_size(10).text_color(t.dim).child(`${done}/${this.steps.length} steps`)))
      .child(h_flex().h(3).w_full().rounded(2).bg(t.border)
        .child(div().h(3).rounded(2).bg(color).w(`${pct}%`)));
  }

  intentBlock(t, r) {
    const text = r.intent || "No intent recorded";
    const long = text.length > 220;
    const shown = this.intentOpen || !long ? text : `${text.slice(0, 220)}…`;
    return v_flex().flex_none().gap(3)
      .child(div().text_size(9).text_color(t.dim).child("INTENT"))
      .child(div().text_size(11).text_color(t.muted).child(shown))
      .when(long, (el) => el.child(div().id("intent-more").text_size(10).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.intentOpen = !this.intentOpen; cx.notify(); })
        .child(this.intentOpen ? "less" : "more")));
  }

  timeline(t, cx) {
    const max = Math.max(1, ...this.steps.map((s) => Number(s.duration_ms) || 0));
    return v_flex().flex_none().gap(2)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(9).text_color(t.dim).child("PIPELINE"))
        .child(div().flex_1())
        .child(div().text_size(9).text_color(t.dim).child("click a step to inspect")))
      .children(this.steps.map((s) => {
        const selected = s.step_name === this.selectedStep;
        const color = statusColor(t, s.status);
        const pct = Math.round(100 * (Number(s.duration_ms) || 0) / max);
        const findings = parseFindings(s.findings_json).findings.length;
        return h_flex().id(`step-${s.step_name}`).flex_none().h(24).gap(8).items_center()
          .rounded(5).px(4).cursor_pointer()
          .bg(selected ? t.hover : t.background)
          .on_click((_e, cx) => this.selectStep(s.step_name, cx))
          .child(s.status === "pending" ? div().w(8).h(8).rounded(4).flex_none().border_1().border_color(t.border) : this.dot(color, 8))
          .child(div().w(76).flex_none().text_size(11)
            .text_color(s.status === "pending" ? t.dim : t.foreground).child(s.step_name))
          .child(div().w(64).flex_none().text_size(10).text_color(color).truncate()
            .child(label(s.status)))
          .child(h_flex().flex_1().min_w(60).h(4).rounded(2).bg(t.border)
            .child(div().h(4).rounded(2).bg(color).w(`${pct}%`)))
          .child(div().w(64).flex_none().text_size(10).text_color(t.muted)
            .child(s.duration_ms == null ? "—" : fmtDuration(s.duration_ms)))
          .when(findings > 0, (el) => el.child(div().text_size(10).text_color(t.blocked).child(String(findings))))
          .when(s.exit_code != null && s.exit_code !== 0, (el) => el
            .child(div().text_size(10).text_color(t.ansi1).child(`exit ${s.exit_code}`)));
      }))
      .when(!this.steps.length, (el) => el.child(div().text_size(11).text_color(t.dim).child("No steps recorded")));
  }

  tabs(t, cx) {
    const defs = [["logs", "Logs"], ["findings", "Findings"], ["metrics", "Metrics"], ["rounds", "Rounds"]];
    return h_flex().flex_none().h(34).gap(18).items_center().border_b(1).border_color(t.border)
      .children(defs.map(([key, text]) => v_flex().id(`tab-${key}`).h(34).justify_center().gap(4)
        .cursor_pointer().on_click((_e, cx) => this.setTab(key, cx))
        .child(div().text_size(11).text_color(this.tab === key ? t.accent : t.muted).child(text))
        .child(div().h(2).w_full().bg(this.tab === key ? t.accent : t.background))));
  }

  tabBody(t, cx) {
    if (this.tab === "findings") return this.findingsTab(t);
    if (this.tab === "metrics") return this.metricsTab(t);
    if (this.tab === "rounds") return this.roundsTab(t);
    return this.logsTab(t, cx);
  }

  logsTab(t, cx) {
    const step = this.steps.find((s) => s.step_name === this.selectedStep);
    const lines = this.visibleLog();
    return v_flex().flex_1().min_h(0).gap(6)
      .child(h_flex().flex_none().h(22).gap(12).items_center()
        .child(div().text_size(10).text_color(t.dim)
          .child(step ? `${step.step_name} · ${this.logTotal} lines` : "no log selected"))
        .child(div().id("log-follow").text_size(10).cursor_pointer()
          .text_color(this.logFollow ? t.accent : t.muted)
          .on_click((_e, cx) => {
            this.logFollow = !this.logFollow;
            if (this.logFollow) this.scrollLogBottom();
            cx.notify();
          })
          .child(this.logFollow ? "Follow ✓" : "Follow"))
        .child(div().id("log-errors").text_size(10).cursor_pointer()
          .text_color(this.logErrors ? t.ansi1 : t.muted)
          .on_click((_e, cx) => { this.logErrors = !this.logErrors; cx.notify(); })
          .child("Errors"))
        .child(div().flex_1())
        .child(div().text_size(10).text_color(t.dim).child(this.logFollow ? "live" : "paused")))
      .child(v_flex().id("nm-log").flex_1().min_h(0).overflow_y_scrollbar()
        .track_scroll(this.logScroll)
        .font_family(settings()?.font_family || "JetBrains Mono").text_size(11)
        .children(lines.map((line, i) => h_flex().flex_none().gap(10).px(4).items_start()
          .child(div().w(34).flex_none().text_right().text_color(t.dim).child(String(i + 1)))
          .child(div().flex_1().min_w(0).whitespace_normal().text_color(lineColor(t, line)).child(line || " "))))
        .when(!lines.length, (el) => el.child(div().p(8).text_size(11).text_color(t.dim)
          .child(this.logPath ? (this.logErrors ? "No error lines" : "Log is empty") : "Select a step with a log"))));
  }

  findingsTab(t) {
    const step = this.steps.find((s) => s.step_name === this.selectedStep);
    const f = parseFindings(step?.findings_json);
    return v_flex().id("nm-findings").flex_1().min_h(0).overflow_y_scrollbar().p(2).gap(8)
      .child(h_flex().flex_none().h(20).gap(8).items_center()
        .child(div().text_size(10).text_color(t.dim)
          .child(step ? `${step.step_name} · ${label(step.status)}` : "Findings"))
        .child(div().flex_1())
        .when(Boolean(step?.log_path), (el) => el.child(div().id("findings-log").text_size(10)
          .text_color(t.accent).cursor_pointer().on_click((_e, cx) => this.setTab("logs", cx)).child("log"))))
      .when(Boolean(f.summary), (el) => el.child(div().text_size(11).text_color(t.muted).child(f.summary)))
      .children(f.findings.map((f2, i) => v_flex().id(`finding-${i}`).flex_none().rounded(6)
        .border_1().border_color(t.border).p(10).gap(4)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(10).text_color(severityColor(t, f2.severity)).child(String(f2.severity || "info")))
          .child(div().text_size(10).text_color(t.muted)
            .child([f2.file, f2.line].filter((x) => x != null).join(":")))
          .child(div().flex_1())
          .when(Boolean(f2.action), (el) => el.child(div().text_size(10).text_color(t.dim).child(f2.action))))
        .child(div().text_size(11).text_color(t.foreground).child(f2.description || ""))
        .when(Boolean(f2.instructions), (el) => el
          .child(div().text_size(10).text_color(t.dim).child(f2.instructions)))))
      .when(!f.findings.length, (el) => el.child(div().p(8).text_size(11).text_color(t.dim)
        .child(step ? "No findings recorded for this step" : "Select a step")));
  }

  metricsTab(t) {
    const inv = this.invocations;
    const input = inv.reduce((n, x) => n + (Number(x.input_tokens) || 0), 0);
    const output = inv.reduce((n, x) => n + (Number(x.output_tokens) || 0), 0);
    const cache = inv.reduce((n, x) => n + (Number(x.cache_read_tokens) || 0), 0);
    return v_flex().id("nm-metrics").flex_1().min_h(0).overflow_y_scrollbar().p(2).gap(10)
      .child(this.tokenBar(t, input, output, cache))
      .child(h_flex().flex_none().h(22).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().w(90).flex_none().text_size(9).text_color(t.dim).child("STEP"))
        .child(div().w(34).flex_none().text_size(9).text_color(t.dim).child("RND"))
        .child(div().flex_1().text_size(9).text_color(t.dim).child("AGENT / MODEL"))
        .child(div().w(64).flex_none().text_size(9).text_color(t.dim).text_right().child("DURATION"))
        .child(div().w(64).flex_none().text_size(9).text_color(t.dim).text_right().child("TOKENS"))
        .child(div().w(44).flex_none().text_size(9).text_color(t.dim).text_right().child("TOOLS"))
        .child(div().w(60).flex_none().text_size(9).text_color(t.dim).text_right().child("EXIT")))
      .children(inv.map((x, i) => h_flex().id(`inv-${i}`).flex_none().h(22).gap(8).items_center()
        .child(div().w(90).flex_none().text_size(10).text_color(t.foreground).truncate().child(x.step_name))
        .child(div().w(34).flex_none().text_size(10).text_color(t.muted).child(String(x.round)))
        .child(div().flex_1().min_w(0).text_size(10).text_color(t.muted).truncate()
          .child(`${x.agent} · ${x.model || "—"}`))
        .child(div().w(64).flex_none().text_size(10).text_color(t.muted).text_right().child(fmtDuration(x.duration_ms)))
        .child(div().w(64).flex_none().text_size(10).text_color(t.muted).text_right()
          .child(fmtTokens((Number(x.input_tokens) || 0) + (Number(x.output_tokens) || 0))))
        .child(div().w(44).flex_none().text_size(10).text_color(t.muted).text_right()
          .child(x.tool_calls == null ? "—" : String(x.tool_calls)))
        .child(div().w(60).flex_none().text_size(10).text_color(x.exit_status === "ok" ? t.done : t.ansi1)
          .text_right().child(x.exit_status || "—"))))
      .when(!inv.length, (el) => el.child(div().p(8).text_size(11).text_color(t.dim).child("No agent invocations recorded")));
  }

  tokenBar(t, input, output, cache) {
    const total = Math.max(1, input + output + cache);
    const W = 320;
    const cacheW = Math.max(2, Math.round(W * cache / total));
    const inputW = Math.max(2, Math.round(W * Math.max(0, input - cache) / total));
    const outputW = Math.max(2, Math.round(W * output / total));
    return v_flex().flex_none().gap(5)
      .child(h_flex().h(8).w(W).rounded(4).overflow_hidden().bg(t.border)
        .child(div().h(8).w(cacheW).bg(t.ansi5))
        .child(div().h(8).w(inputW).bg(t.ansi6))
        .child(div().h(8).w(outputW).bg(t.ansi3)))
      .child(h_flex().gap(12).items_center()
        .child(div().text_size(10).text_color(t.ansi5).child(`cache ${fmtTokens(cache)}`))
        .child(div().text_size(10).text_color(t.ansi6).child(`input ${fmtTokens(input)}`))
        .child(div().text_size(10).text_color(t.ansi3).child(`output ${fmtTokens(output)}`)));
  }

  roundsTab(t) {
    return v_flex().id("nm-rounds").flex_1().min_h(0).overflow_y_scrollbar().p(2).gap(8)
      .children(this.rounds.map((r, i) => v_flex().id(`round-${i}`).flex_none().rounded(6)
        .border_1().border_color(t.border).p(10).gap(4)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(10).text_color(t.muted).child(`${r.step_name} · round ${r.round}`))
          .child(div().text_size(10).text_color(t.dim).child(r.trigger_type || ""))
          .child(div().flex_1())
          .child(div().text_size(10).text_color(t.dim).child(fmtDuration(r.duration_ms))))
        .when(Boolean(r.fix_summary), (el) => el.child(div().text_size(11).text_color(t.muted).child(r.fix_summary)))
        .child(div().text_size(10).text_color(t.dim)
          .child(`${parseFindings(r.findings_json).findings.length} findings · ${r.selection_source || "no selection"}`))))
      .when(!this.rounds.length, (el) => el.child(div().p(8).text_size(11).text_color(t.dim).child("No rounds recorded")));
  }

  rightRail(t, cx) {
    const r = this.run;
    const gate = gateStep(this.steps);
    return v_flex().w(300).flex_none().h_full().min_h(0).border_l(1).border_color(t.border)
      .p(12).gap(12).overflow_y_scrollbar()
      .when(Boolean(gate), (el) => el.child(this.gateCard(t, gate)))
      .child(this.prCard(t))
      .child(this.factsCard(t))
      .when(Boolean(r), (el) => el.child(this.historyCard(t, cx)));
  }

  gateCard(t, step) {
    const f = parseFindings(step.findings_json);
    return v_flex().flex_none().rounded(8).border_1().border_color(t.blocked).p(11).gap(7)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(10).text_color(t.blocked).child(`GATE · ${step.step_name}`))
        .child(div().flex_1())
        .child(div().text_size(10).text_color(t.muted)
          .child(f.findings.length ? `${f.findings.length} findings` : "")))
      .when(Boolean(f.summary), (el) => el.child(div().text_size(11).text_color(t.muted).child(clip(f.summary, 180))))
      .children(f.findings.slice(0, 3).map((x, i) => v_flex().id(`gate-finding-${i}`).gap(2)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(10).text_color(severityColor(t, x.severity)).child(String(x.severity || "info")))
          .child(div().text_size(10).text_color(t.muted)
            .child([x.file, x.line].filter((v) => v != null).join(":"))))
        .child(div().text_size(10).text_color(t.foreground).child(clip(x.description || "", 100)))))
      .child(h_flex().gap(8).items_center()
        .when(ACTIVE.has(this.run?.status), (el) => el.child(this.button(t, "gate-tui", "Open TUI", (cx) => this.openTui(cx))))
        .child(div().flex_1())
        .child(div().text_size(10).text_color(t.dim).child("read-only")));
  }

  prCard(t) {
    const r = this.run;
    const url = r?.pr_url;
    return v_flex().flex_none().rounded(8).border_1().border_color(t.border).p(11).gap(5)
      .child(h_flex().items_center()
        .child(div().text_size(9).text_color(t.dim).child("PR / CI"))
        .child(div().flex_1())
        .when(Boolean(url), (el) => el.child(div().id("pr-open").text_size(10).text_color(t.accent)
          .cursor_pointer().on_click((_e, _cx) => this.openUrl(url)).child("open"))))
      .child(div().text_size(11).text_color(t.foreground)
        .child(r?.pr_state && r.pr_state !== "none" ? `PR ${r.pr_state}` : "No PR yet"))
      .child(div().text_size(10).text_color(t.muted)
        .child(r?.ci_ready_at ? `checks passed · ${age(r.ci_ready_at)}` : "CI —"))
      .when(Boolean(url), (el) => el.child(div().text_size(9).text_color(t.dim).truncate()
        .cursor_pointer().on_click((_e) => this.openUrl(url)).child(url)));
  }

  factsCard(t) {
    const r = this.run;
    if (!r) return div();
    const parked = Number(r.parked_ms) || 0;
    return v_flex().flex_none().rounded(8).border_1().border_color(t.border).p(11).gap(4)
      .child(div().text_size(9).text_color(t.dim).child("RUN"))
      .child(div().text_size(10).text_color(t.foreground).font_family(settings()?.font_family || "JetBrains Mono")
        .child(`${r.id.slice(0, 10)}… · ${shortSha(r.head_sha)}`))
      .child(div().text_size(10).text_color(t.muted).child(`base ${shortSha(r.base_sha)}`))
      .when(Boolean(r.awaiting_agent_since), (el) => el
        .child(div().text_size(10).text_color(t.blocked).child(`waiting ${age(r.awaiting_agent_since)}`)))
      .when(parked > 0, (el) => el
        .child(div().text_size(10).text_color(t.muted).child(`parked total ${fmtDuration(parked)}`)))
      .when(Boolean(r.worktree_dir), (el) => el
        .child(div().text_size(10).text_color(t.dim).truncate().child(r.worktree_dir)));
  }

  historyCard(t, cx) {
    const r = this.run;
    const hist = this.runs.filter((x) => x.working_path === r.working_path).slice(0, 12).reverse();
    const max = Math.max(1, ...hist.map((x) => Number(x.total_ms) || 0));
    return v_flex().flex_none().gap(6)
      .child(div().text_size(9).text_color(t.dim).child(`HISTORY · ${hist.length}`))
      .child(h_flex().h(56).gap(6).items_end()
        .children(hist.map((x) => div().id(`hist-${x.id}`).w(14).flex_none().rounded(2)
          .h(Math.max(6, Math.round(48 * (Number(x.total_ms) || 1) / max)))
          .bg(x.id === this.selected ? t.accent : x.waiting ? t.blocked : statusColor(t, x.status))
          .cursor_pointer().on_click((_e, cx) => this.selectRun(x.id, cx)))))
      .child(h_flex().gap(6).items_start()
        .children(hist.map((x) => div().w(14).flex_none().text_size(8).text_color(t.dim)
          .text_center().child(age(x.created_at)))));
  }
}

// The checkout of `branch` for the repo at `repo`: the repo itself, or a
// linked worktree (git refuses the same branch twice, so at most one matches).
// The run's own worktree is detached, so it never wins here; the TUI is still
// attached by run id and shows its pipeline from any checkout.
async function branchCheckout(repo, branch, on) {
  if (!repo || !branch) return repo;
  try {
    const r = await exec("git", ["-C", repo, "worktree", "list", "--porcelain"],
      on ? { on, timeout: 15000 } : { timeout: 15000 });
    if (r.code === 0) {
      for (const block of String(r.stdout).split(/\n\s*\n/)) {
        const path = /^worktree (.+)$/m.exec(block);
        const ref = /^branch refs\/heads\/(.+)$/m.exec(block);
        if (path && ref && ref[1].trim() === branch) return path[1].trim();
      }
    }
  } catch {
    // No git, or the repo moved: its own checkout still opens the run.
  }
  return repo;
}

// The log of `step` for the run: its recorded path once the step finished,
// else the conventional path a live step writes to. Pending and skipped steps
// never write one.
async function stepLog(step, runId, on) {
  if (!step) return null;
  if (step.log_path) return step.log_path;
  if (step.status === "pending" || step.status === "skipped") return null;
  try {
    return await stepLogPath(runId, step.step_name, on);
  } catch {
    return null;
  }
}
