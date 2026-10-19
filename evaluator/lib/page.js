/*
 * report.html, client side.
 *
 * The page has one job the terminal table cannot do: get from a number that
 * looks wrong to the trial that produced it without hunting through a
 * directory. So every count is a link, and a trial opens with its verdict, its
 * diff and its full transcript in one scroll.
 */

(() => {
  let data = JSON.parse(document.getElementById('run-data').textContent);
  let trials = data.trials;
  let byId = new Map(trials.map((t) => [t.id, t]));

  const FILTERS = [
    ['all', 'All'],
    ['fail', 'Failed'],
    ['error', 'Errored'],
    ['pass', 'Passed'],
  ];

  const viewKey = `wellactually-evaluator:${data.dir}`;
  const restored = (() => {
    try {
      const saved = JSON.parse(window.name || '{}');
      return saved.key === viewKey ? saved : {};
    } catch {
      return {};
    }
  })();

  // A run is opened because something went wrong, so the page opens on
  // whatever did — and never on a filter that has nothing behind it.
  const defaultFilter = trials.some((t) => t.status === 'fail')
    ? 'fail'
    : trials.some((t) => t.status === 'error')
      ? 'error'
      : 'all';
  const state = {
    filter: restored.filter ?? defaultFilter,
    case: restored.case ?? '',
    arm: restored.arm ?? '',
    query: restored.query ?? '',
    open:
      restored.open ??
      (location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : null),
  };

  /* ------------------------------------------------------------- helpers */

  const esc = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');

  const pct = (part, whole) => (whole === 0 ? 0 : Math.round((part / whole) * 100));

  const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

  const tokenLabel = (n) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);

  /** Dollars when the CLI priced the run, tokens when it only counted them. */
  const spend = (trial) =>
    trial.cost !== null
      ? `$${trial.cost.toFixed(3)}`
      : trial.usage
        ? `${tokenLabel(trial.usage.total)} tok`
        : '';

  const configurationKey = (value) =>
    `${value.harness}\u0000${value.requestedModel ?? value.model}\u0000${value.effort ?? ''}`;
  const trialKey = (value) =>
    `${configurationKey(value)}\u0000${value.case}\u0000${value.arm}\u0000${value.n}`;

  let configurations = [];
  let caseIds = [];
  let activeTrials = new Set();

  function indexData() {
    trials = data.trials;
    byId = new Map(trials.map((trial) => [trial.id, trial]));
    configurations = [
      ...new Map(data.rows.map((row) => [configurationKey(row), row])).values(),
    ];
    caseIds = [...new Set(data.rows.map((row) => row.case))];
    activeTrials = new Set((data.progress?.active ?? []).map(trialKey));
  }

  indexData();

  const cellRows = (caseId, arm, configuration) =>
    data.rows.filter(
      (row) =>
        row.case === caseId &&
        row.arm === arm &&
        configurationKey(row) === configurationKey(configuration),
    );

  const cell = (caseId, arm, configuration) => {
    const rows = cellRows(caseId, arm, configuration);
    if (rows.length === 0) {
      return null;
    }
    return {
      ran: rows.reduce((sum, row) => sum + row.ran, 0),
      passed: rows.reduce((sum, row) => sum + row.passed, 0),
      errors: rows.reduce((sum, row) => sum + row.errors, 0),
    };
  };

  const cellTrials = (caseId, arm, configuration) =>
    trials
      .filter(
        (trial) =>
          trial.case === caseId &&
          trial.arm === arm &&
          configurationKey(trial) === configurationKey(configuration),
      )
      .sort((a, b) => a.n - b.n);

  const axisOf = (caseId) => data.rows.find((r) => r.case === caseId)?.axis ?? '';

  /* ------------------------------------------------------------ markdown */

  function markdown(src) {
    if (!src || !src.trim()) {
      return '<p class="muted">—</p>';
    }
    const parts = String(src).split(/```/);
    return parts
      .map((chunk, index) => {
        if (index % 2 === 1) {
          const nl = chunk.indexOf('\n');
          const body = nl === -1 ? chunk : chunk.slice(nl + 1);
          return `<pre><code>${esc(body.replace(/\n$/, ''))}</code></pre>`;
        }
        return blocks(chunk);
      })
      .join('');
  }

  function blocks(text) {
    const out = [];
    let list = null;

    const closeList = () => {
      if (list) {
        out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`);
        list = null;
      }
    };

    for (const raw of text.split('\n')) {
      const line = raw.trimEnd();
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);

      if (heading) {
        closeList();
        const level = Math.min(heading[1].length + 1, 4);
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (bullet || numbered) {
        const tag = bullet ? 'ul' : 'ol';
        if (!list || list.tag !== tag) {
          closeList();
          list = { tag, items: [] };
        }
        list.items.push(`<li>${inline((bullet ?? numbered)[1])}</li>`);
      } else if (!line.trim()) {
        closeList();
      } else {
        closeList();
        const last = out[out.length - 1];
        if (last && last.startsWith('<p>') && last.endsWith('</p>')) {
          out[out.length - 1] = `${last.slice(0, -4)} ${inline(line)}</p>`;
        } else {
          out.push(`<p>${inline(line)}</p>`);
        }
      }
    }
    closeList();
    return out.join('');
  }

  function inline(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  }

  /* -------------------------------------------------------------- header */

  function header() {
    const completed = data.progress?.completed ?? trials.length;
    const total = data.progress?.total ?? trials.length;

    return `
      <header class="top">
        <div class="brand">
          <span class="mark">◆</span>
          <div>
            <h1>Framing evaluation</h1>
            <p>${esc(data.label)} · ${completed}/${total} trials · ${esc(String(data.options.n ?? '?'))} per cell</p>
          </div>
        </div>
        <div class="env">
          ${
            data.progress?.running
              ? `<span class="chip live" role="status"><i></i>live · ${completed}/${total}</span>`
              : ''
          }
          ${data.judge ? `<span class="chip">judge <b>${esc(data.judge)}</b></span>` : ''}
          <button class="icon-button" id="theme" title="Switch theme" aria-label="Switch theme">◐</button>
        </div>
      </header>`;
  }

  /* ------------------------------------------------------------ overview */

  function overview() {
    const completed = data.progress?.completed ?? trials.length;
    const total = data.progress?.total ?? trials.length;
    const scored = trials.filter((t) => t.status !== 'error');
    const passed = trials.filter((t) => t.status === 'pass').length;
    const failed = trials.filter((t) => t.status === 'fail').length;
    const errored = trials.filter((t) => t.status === 'error').length;
    // Two currencies, because only some agent CLIs price a run. Claude reports
    // dollars; Codex reports tokens and nothing else, so a tile that only knew
    // about dollars would quietly report a Codex run as free.
    const agentCost = trials.reduce((sum, t) => sum + (t.cost ?? 0), 0);
    const judgeCost = trials.reduce((sum, t) => sum + (t.judgeCost ?? 0), 0);
    const cost = agentCost + judgeCost;
    const tokens = trials.reduce((sum, t) => sum + (t.usage?.total ?? 0), 0);
    const priced = trials.filter((t) => t.cost !== null).length;
    const unpriced = trials.filter((t) => t.cost === null && t.usage).length;

    const controls = data.rows.filter((r) => r.axis === 'control');
    const controlOk = controls.reduce((sum, r) => sum + r.passed, 0);
    const controlRan = controls.reduce((sum, r) => sum + r.ran, 0);

    const alerts = data.alerts
      .map(
        (a) => `
        <div class="alert ${a.level}">
          <span class="glyph">${a.level === 'error' ? '■' : '▲'}</span>
          <h3>${esc(a.title)}</h3>
          <p>${esc(a.body)}</p>
        </div>`,
      )
      .join('');

    const models = data.environment
      .map((environment) => {
        const requested = environment.requested ?? '';
        const resolved = environment.resolved ?? requested;
        const resolution =
          resolved && resolved !== requested
            ? `<span class="model-requested">${esc(requested)} →</span>`
            : '';
        return `
          <div class="model-card">
            <span class="model-harness">${esc(environment.harness ?? 'agent')}</span>
            <span class="model-name">${resolution}${esc(resolved)}</span>
            <span class="model-effort">Effort ${esc(environment.effort ?? 'CLI default')}</span>
            ${environment.cli ? `<span class="model-cli">CLI ${esc(environment.cli)}</span>` : ''}
          </div>`;
      })
      .join('');

    return `
      <section id="overview">
        <div class="model-roster" aria-label="Models under evaluation">
          <div class="model-roster-head">
            <div>
              <span class="eyebrow">Models under evaluation</span>
              <h2>These models run every selected case</h2>
            </div>
            ${data.judge ? `<span class="judge-note">Judge: <b>${esc(data.judge)}</b></span>` : ''}
          </div>
          <div class="model-cards">${models}</div>
        </div>
        ${alerts ? `<div class="alerts">${alerts}</div>` : ''}
        <div class="stats">
          <div class="stat">
            <div class="label">Trials</div>
            <div class="value">${completed}<span style="font-size:16px;color:var(--faint)">/${total}</span></div>
            <div class="note">${
              data.progress?.running
                ? `${count(total - completed, 'trial')} still running`
                : count(data.rows.length, 'cell')
            }</div>
            <div class="meter">
              <i class="m-pass" style="width:${pct(passed, total)}%"></i>
              <i class="m-fail" style="width:${pct(failed, total)}%"></i>
              <i class="m-error" style="width:${pct(errored, total)}%"></i>
            </div>
          </div>
          <div class="stat pass">
            <div class="label">Passed</div>
            <div class="value">${passed}<span style="font-size:16px;color:var(--faint)">/${scored.length}</span></div>
            <div class="note">${
              scored.length === 0 ? 'nothing was scored' : `${pct(passed, scored.length)}% of scored trials`
            }</div>
          </div>
          <div class="stat ${failed ? 'fail' : ''}">
            <div class="label">Failed</div>
            <div class="value">${failed}</div>
            <div class="note">${failed ? 'judged against the rubric' : 'nothing was judged wrong'}</div>
          </div>
          <div class="stat ${errored ? 'warn' : ''}">
            <div class="label">Errored</div>
            <div class="value">${errored}</div>
            <div class="note">${errored ? 'never produced a result' : 'every trial ran'}</div>
          </div>
          <div class="stat ${controlRan && controlOk < controlRan ? 'fail' : ''}">
            <div class="label">Controls</div>
            <div class="value">${controlRan ? `${controlOk}/${controlRan}` : '—'}</div>
            <div class="note">${
              !controlRan
                ? 'none ran'
                : controlOk === controlRan
                  ? 'pipeline looks sound'
                  : 'the other numbers are suspect'
            }</div>
          </div>
          ${
            cost
              ? `<div class="stat">
                   <div class="label">${agentCost ? 'Cost' : 'Judge cost'}</div>
                   <div class="value">$${cost.toFixed(2)}</div>
                   <div class="note">${esc(
                     [
                       // Naming what is missing, because a Codex run that spent
                       // real money would otherwise read as an agent that cost
                       // nothing.
                       agentCost ? `agent $${agentCost.toFixed(2)}` : 'the agent CLI reported no price',
                       judgeCost ? `judge $${judgeCost.toFixed(2)}` : 'judge not recorded',
                       unpriced ? `${count(unpriced, 'trial')} in tokens only` : '',
                     ]
                       .filter(Boolean)
                       .join(' · '),
                   )}</div>
                 </div>`
              : ''
          }
          ${
            tokens
              ? `<div class="stat">
                   <div class="label">Tokens</div>
                   <div class="value">${tokenLabel(tokens)}</div>
                   <div class="note">${esc(
                     priced === trials.length
                       ? 'input and output, as the CLI reported them'
                       : 'input and output — the only measure every harness reports',
                   )}</div>
                 </div>`
              : ''
          }
        </div>
      </section>`;
  }

  /* -------------------------------------------------------------- matrix */

  function matrix() {
    const arms = data.arms;
    const trialsPerCell = Number(data.options.n ?? 0);
    // The delta compares the baseline against whichever arm was run beside it.
    // With more than one there is no single delta to quote, so the column says
    // nothing rather than picking a favourite.
    const others = arms.filter((arm) => arm !== data.baseline);
    const compared = data.baseline && others.length === 1 ? others[0] : null;

    const rows = configurations
      .flatMap((configuration) =>
        caseIds
          .filter((caseId) =>
            data.rows.some(
              (row) =>
                row.case === caseId &&
                configurationKey(row) === configurationKey(configuration),
            ),
          )
          .map((caseId) => {
        const cells = arms
          .map((arm) => {
            const row = cell(caseId, arm, configuration);
            if (!row) {
              return '<td><span class="ratio">—</span></td>';
            }
            const completed = cellTrials(caseId, arm, configuration);
            const expected = trialsPerCell * cellRows(caseId, arm, configuration).length;
            const planned = Math.max(expected, completed.length, row.ran + row.errors);
            const byNumber = new Map(completed.map((trial) => [trial.n, trial]));
            const dots = Array.from({ length: planned }, (_, index) => {
              const n = index + 1;
              const trial = byNumber.get(n);
              if (!trial) {
                const running = activeTrials.has(
                  trialKey({
                    ...configuration,
                    case: caseId,
                    arm,
                    n,
                  }),
                );
                return `<span class="dot ${running ? 'running' : 'pending'}" title="trial ${n} · ${
                  running ? 'running' : 'queued'
                }" aria-label="trial ${n}, ${running ? 'running' : 'queued'}"></span>`;
              }
              return `<button class="dot ${trial.status}" data-trial="${esc(trial.id)}" title="${esc(
                `trial ${trial.n} · ${trial.status} — ${trial.reason}`,
              )}" aria-label="trial ${trial.n}, ${trial.status}"></button>`;
            }).join('');
            const running = Array.from({ length: planned }, (_, index) =>
              activeTrials.has(
                trialKey({
                  ...configuration,
                  case: caseId,
                  arm,
                  n: index + 1,
                }),
              ),
            ).some(Boolean);
            const tone =
              completed.length < planned
                ? running
                  ? 'running'
                  : 'pending'
                : row.passed === planned
                  ? 'all'
                  : row.passed === 0
                    ? 'none'
                    : 'some';
            return `
              <td>
                <div class="cell">
                  <span class="ratio ${tone}">${row.passed}/${planned}</span>
                  <span class="dots">${dots}</span>
                </div>
              </td>`;
          })
          .join('');

        const base = data.baseline ? cell(caseId, data.baseline, configuration) : null;
        const other = compared ? cell(caseId, compared, configuration) : null;
        let delta = '<span class="delta">—</span>';
        if (base && other && base.ran > 0 && other.ran > 0) {
          const change = pct(other.passed, other.ran) - pct(base.passed, base.ran);
          const tone = change > 0 ? 'up' : change < 0 ? 'down' : '';
          delta = `<span class="delta ${tone}">${change > 0 ? '+' : ''}${change}pp</span>`;
        }

        const parts = caseId.split('/');
        const axis = axisOf(caseId);
        return `
          <tr>
            <td class="agent-config">
              <b>${esc(configuration.harness)}</b>
              <span>${esc(configuration.model)} · ${esc(configuration.effort ?? 'default')}</span>
            </td>
            <td class="case-name">${esc(parts.slice(0, -1).join('/'))}<span>/</span>${esc(parts.at(-1) ?? '')}</td>
            <td><span class="badge axis-${esc(axis)}">${esc(axis)}</span></td>
            ${cells}
            <td>${delta}</td>
          </tr>`;
          }),
      )
      .join('');

    return `
      <section id="matrix">
        <div class="section-head">
          <h2>Arms, side by side</h2>
          <p>Each square is one trial — click it.${
            compared ? ` Δ is ${esc(compared)}'s pass rate minus ${esc(data.baseline)}'s.` : ''
          }</p>
          <div class="run-legend" aria-label="Trial states">
            <span><i class="dot pending" aria-hidden="true"></i>queued</span>
            <span><i class="dot running" aria-hidden="true"></i>running</span>
          </div>
        </div>
        <div class="card matrix">
          <table class="grid">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Case</th>
                <th>Axis</th>
                ${data.arms.map((arm) => `<th>${esc(arm)}</th>`).join('')}
                <th>Δ</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
  }

  /* -------------------------------------------------------------- trials */

  function visible() {
    return trials.filter((t) => {
      if (state.filter !== 'all' && t.status !== state.filter) {
        return false;
      }
      if (state.case && t.case !== state.case) {
        return false;
      }
      if (state.arm && t.arm !== state.arm) {
        return false;
      }
      if (state.query) {
        const hay = `${t.id} ${t.reason} ${t.answer} ${t.case}`.toLowerCase();
        if (!hay.includes(state.query.toLowerCase())) {
          return false;
        }
      }
      return true;
    });
  }

  function trialSection() {
    return `
      <section id="trials">
        <div class="section-head">
          <h2>Trials</h2>
          <p>Everything one run of one arm produced, in the order it was queued.</p>
          <div class="hint-bar">
            <span><kbd>j</kbd><kbd>k</kbd> move</span>
            <span><kbd>f</kbd> failures</span>
            <span><kbd>/</kbd> search</span>
            <span><kbd>esc</kbd> close</span>
          </div>
        </div>
        <div class="filters">
          <div class="segmented" id="filter">
            ${FILTERS.map(([key, label]) => {
              const count =
                key === 'all' ? trials.length : trials.filter((t) => t.status === key).length;
              return `<button data-filter="${key}" aria-pressed="${state.filter === key}">${label}<span class="count">${count}</span></button>`;
            }).join('')}
          </div>
          <select id="case-filter" aria-label="Filter by case">
            <option value="">All cases</option>
            ${caseIds.map((id) => `<option value="${esc(id)}"${state.case === id ? ' selected' : ''}>${esc(id)}</option>`).join('')}
          </select>
          <select id="arm-filter" aria-label="Filter by arm">
            <option value="">All arms</option>
            ${data.arms.map((arm) => `<option value="${esc(arm)}"${state.arm === arm ? ' selected' : ''}>${esc(arm)}</option>`).join('')}
          </select>
          <input type="search" id="search" placeholder="Search answers and reasons…" value="${esc(state.query)}">
        </div>
        <div class="trial-list" id="list">${listHtml()}</div>
      </section>`;
  }

  function listHtml() {
    const items = visible();
    if (items.length === 0) {
      return '<div class="empty">Nothing matches those filters.</div>';
    }
    return items
      .map(
        (t) => `
        <button class="trial" data-trial="${esc(t.id)}">
          <span class="status ${t.status}"></span>
          <span class="title">
            ${esc(t.case)}
            <span class="badge axis-${esc(t.axis)}">${esc(t.axis)}</span>
            <span class="arm ${t.arm === data.baseline ? 'floor' : 'treated'}">${esc(t.arm)}</span>
            <span style="color:var(--faint)">#${t.n}</span>
          </span>
          <span class="reason">${esc(t.reason || 'No reason recorded.')}</span>
          <span class="aside">${esc(t.model)} · ${esc(t.effort ?? 'default')}${spend(t) ? `<br>${esc(spend(t))}` : ''}</span>
        </button>`,
      )
      .join('');
  }

  function renderList() {
    patchHtml(document.getElementById('list'), listHtml());
  }

  /* -------------------------------------------------------------- drawer */

  function factsTable(facts) {
    if (!facts || Object.keys(facts).length === 0) {
      return '<p class="muted">No facts recorded.</p>';
    }
    return `<table class="facts">${Object.entries(facts)
      .map(([key, value]) => {
        const text =
          typeof value === 'string' ? value : JSON.stringify(value, null, value && typeof value === 'object' ? 2 : 0);
        const tone = value === true ? 'bool-true' : value === false ? 'bool-false' : '';
        return `<tr><td>${esc(key)}</td><td class="${tone}">${esc(text)}</td></tr>`;
      })
      .join('')}</table>`;
  }

  /**
   * Every counter exactly as the CLI reported it, next to the totals the page
   * derived from them. The two harnesses count the cache differently, so the
   * arithmetic is worth being able to check.
   */
  function spendTable(trial) {
    const rows = [];
    if (trial.cost !== null) {
      rows.push(['total_cost_usd', `$${trial.cost.toFixed(4)}`]);
    }
    if (trial.judgeCost !== null) {
      rows.push(['judge total_cost_usd', `$${trial.judgeCost.toFixed(4)}`]);
    }
    for (const [key, value] of Object.entries(trial.usage?.raw ?? {})) {
      rows.push([key, value.toLocaleString('en-US')]);
    }
    if (trial.usage) {
      rows.push(['— input, summed', trial.usage.input.toLocaleString('en-US')]);
      rows.push(['— output, summed', trial.usage.output.toLocaleString('en-US')]);
    }
    if (rows.length === 0) {
      return `<p class="muted">${
        trial.status === 'error'
          ? 'Nothing was reported — the trial errored.'
          : 'This harness reports neither cost nor tokens.'
      }</p>`;
    }
    return `<table class="facts">${rows
      .map(([key, value]) => `<tr><td>${esc(key)}</td><td>${esc(value)}</td></tr>`)
      .join('')}</table>`;
  }

  function diffHtml(diff) {
    return `<div class="diff">${diff
      .split('\n')
      .map((line) => {
        const type = line.startsWith('@@')
          ? 'hunk'
          : line.startsWith('diff ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('Only in')
            ? 'file'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : '';
        return `<div class="${type}">${esc(line) || '&nbsp;'}</div>`;
      })
      .join('')}</div>`;
  }

  function turnsHtml(turns) {
    if (turns.length === 0) {
      return '<p class="muted">No transcript was captured.</p>';
    }
    return `<div class="turns">${turns
      .map((turn) => {
        const body = turn.segments
          .map((segment) =>
            segment.type === 'code'
              ? `<pre><code>${esc(segment.text)}</code></pre>`
              : `<div class="prose">${markdown(segment.text)}</div>`,
          )
          .join('');
        // Tool results are the bulk of a transcript and rarely what is being
        // looked for; they stay one click away instead of in the way.
        const collapsed = turn.kind === 'result' || turn.kind === 'thinking';
        return `
          <div class="turn ${turn.kind}">
            <div class="head">${turn.kind}${
              turn.label && turn.label !== turn.kind ? `<span class="name">${esc(turn.label)}</span>` : ''
            }</div>
            <div class="body">${
              collapsed ? `<details><summary>show ${esc(turn.label)}</summary>${body}</details>` : body
            }</div>
          </div>`;
      })
      .join('')}</div>`;
  }

  function block(title, hint, body, open) {
    return `
      <details class="block"${open ? ' open' : ''}>
        <summary>${esc(title)}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</summary>
        <div class="block-body">${body}</div>
      </details>`;
  }

  function judgeHtml(trial) {
    const parsed = trial.judgeReply && (trial.status === 'pass' || trial.status === 'fail');
    const verdict = trial.status === 'pass' ? 'PASS' : 'FAIL';
    const result = parsed
      ? `<div class="verdict ${trial.status} judge-verdict" role="status" aria-label="Judge verdict: ${verdict}">
           <span class="tag">${verdict}</span>
           <span>${esc(trial.reason || 'No reason recorded.')}</span>
         </div>`
      : trial.reason.startsWith('check failed:')
        ? // A failing check decides the trial before the judge is paid, so there is no reply to show.
          `<p>Not sent to the judge: ${esc(trial.reason.replace('check failed: ', ''))} already failed the trial, as code.</p>`
        : `<pre class="wrap">${esc(trial.judgeReply || 'No judge response was recorded.')}</pre>`;

    const raw = parsed
      ? `<details class="raw-judge">
           <summary>Raw JSON response</summary>
           <pre class="wrap">${esc(trial.judgeReply)}</pre>
         </details>`
      : '';

    return `${result}
      ${raw}
      <details class="raw-judge">
        <summary>Whole judge prompt</summary>
        <pre class="wrap">${esc(trial.judgePrompt)}</pre>
      </details>`;
  }

  function drawerBody(trial) {
    const failed = trial.status !== 'pass';
    const tag = { pass: 'PASS', fail: 'FAIL', error: 'ERROR' }[trial.status];

    return `
      <div class="drawer-head">
        <div class="row">
          <h2>${esc(trial.case)} · ${esc(trial.arm)} · trial ${trial.n}</h2>
          <div class="drawer-nav">
            <button class="icon-button" data-nav="-1" title="Previous trial (k)" aria-label="Previous trial">↑</button>
            <button class="icon-button" data-nav="1" title="Next trial (j)" aria-label="Next trial">↓</button>
            <button class="icon-button" data-close title="Close (Esc)" aria-label="Close">✕</button>
          </div>
        </div>
        <div class="verdict ${trial.status}">
          <span class="tag">${tag}</span>
          <span>${esc(trial.reason || 'No reason recorded.')}</span>
        </div>
        <div class="drawer-meta">
          <span class="badge axis-${esc(trial.axis)}">${esc(trial.axis)}</span>
          <span class="chip">harness <b>${esc(trial.harness)}</b></span>
          <span class="chip">model <b>${esc(trial.model)}</b></span>
          <span class="chip">effort <b>${esc(trial.effort ?? 'CLI default')}</b></span>
          ${trial.turns ? `<span class="chip">turns <b>${trial.turns}</b></span>` : ''}
          ${trial.cost ? `<span class="chip">agent <b>$${trial.cost.toFixed(3)}</b></span>` : ''}
          ${trial.judgeCost ? `<span class="chip">judge <b>$${trial.judgeCost.toFixed(3)}</b></span>` : ''}
          ${trial.usage ? `<span class="chip">tokens <b>${tokenLabel(trial.usage.total)}</b></span>` : ''}
        </div>
      </div>
      <div class="drawer-body">
        ${block('Prompt', '', `<div class="prose">${markdown(trial.prompt)}</div>`, true)}
        ${block(
          'Injected into the agent',
          trial.arm === data.baseline ? 'baseline arm' : '',
          trial.injected
            ? `<pre class="wrap">${esc(trial.injected)}</pre>`
            : `<p class="muted">${
                trial.arm === data.baseline
                  ? 'Nothing. This is the baseline arm.'
                  : trial.status === 'error'
                    ? 'Nothing was recorded before the trial errored.'
                    : 'The hook ran but no principle fired.'
              }</p>`,
          trial.arm !== data.baseline && failed,
        )}
        ${block('Final answer', `${trial.answer.length} chars`, `<div class="prose">${markdown(trial.answer)}</div>`, true)}
        ${block(
          'What changed on disk',
          trial.diff ? '' : trial.status === 'error' ? 'not taken' : 'untouched',
          trial.diff
            ? diffHtml(trial.diff)
            : `<p class="muted">${
                // An errored trial was never diffed, which is not the same
                // thing as a trial that changed nothing.
                trial.status === 'error'
                  ? 'No diff was taken — the trial errored before it was scored.'
                  : 'The agent left the fixture exactly as it found it.'
              }</p>`,
          failed && Boolean(trial.diff),
        )}
        ${block('Facts given to the judge', '', factsTable(trial.facts), failed)}
        ${block('Rubric applied', '', `<div class="prose">${markdown(trial.rubric)}</div>`, failed)}
        ${block('What it spent', spend(trial), spendTable(trial), false)}
        ${block('Transcript', `${trial.transcript.length} turns`, turnsHtml(trial.transcript), false)}
        ${block(
          'Judge',
          trial.status === 'pass' || trial.status === 'fail'
            ? `${trial.status.toUpperCase()} · parsed JSON`
            : 'raw response',
          judgeHtml(trial),
          false,
        )}
        <p style="font-size:12px;color:var(--faint);font-family:var(--mono);word-break:break-all;margin-top:14px">${esc(trial.path)}</p>
      </div>`;
  }

  function remember() {
    const drawer = document.getElementById('drawer');
    window.name = JSON.stringify({
      key: viewKey,
      ...state,
      pageScroll: window.scrollY,
      drawerScroll: drawer?.scrollTop ?? 0,
    });
  }

  function open(id, persist = true) {
    const trial = byId.get(id);
    if (!trial) {
      return;
    }
    state.open = id;
    document.getElementById('drawer').innerHTML = drawerBody(trial);
    rendered.set('drawer', document.getElementById('drawer').outerHTML);
    document.body.classList.add('open');
    document.getElementById('drawer').scrollTop = 0;
    history.replaceState(null, '', `#${id}`);
    if (persist) {
      remember();
    }
  }

  function close() {
    state.open = null;
    document.body.classList.remove('open');
    history.replaceState(null, '', location.pathname + location.search);
    remember();
  }

  function step(direction) {
    // Stepping follows the list on screen, so "next" after filtering to the
    // failures is the next failure and not the next trial that happened to run.
    const items = visible();
    const at = items.findIndex((t) => t.id === state.open);
    const next = items[(at === -1 ? 0 : at + direction + items.length) % items.length];
    if (next) {
      open(next.id);
    }
  }

  /* ------------------------------------------------------- live updates */

  function appHtml() {
    const opened = state.open ? byId.get(state.open) : null;
    return `
      ${header()}
      <main>
        ${overview()}
        ${matrix()}
        ${trialSection()}
      </main>
      <div class="scrim" id="scrim"></div>
      <aside class="drawer" id="drawer" aria-label="Trial detail">${
        opened ? drawerBody(opened) : ''
      }</aside>`;
  }

  const morphOptions = {
    getNodeKey: (node) => node.id || undefined,
    onBeforeElUpdated: (current, incoming) => {
      if (current.tagName === 'DETAILS') {
        incoming.toggleAttribute('open', current.open);
      }
      // Let the browser keep selection, focus and control state when a whole
      // subtree is byte-for-byte unchanged.
      return !current.isEqualNode(incoming);
    },
  };

  function patchHtml(element, html) {
    if (typeof morphdom === 'function') {
      const incoming = element.cloneNode(false);
      incoming.innerHTML = html;
      morphdom(element, incoming, morphOptions);
      return;
    }
    if (element.innerHTML === html) {
      return;
    }
    // Without morphdom: build the new tree, but keep every live element whose
    // markup did not change since it was last rendered. An open trial that
    // already finished renders the same every second, so its drawer survives
    // with its scroll position, its opened sections and any selected text.
    // Moving a node out of the document and back resets its scroll, so every
    // scrolled element is measured before the swap and put back after it.
    const scrolled = [...element.querySelectorAll('*')]
      .filter((node) => node.scrollTop > 0 || node.scrollLeft > 0)
      .map((node) => [node, node.scrollTop, node.scrollLeft]);
    const incoming = document.createElement(element.tagName);
    incoming.innerHTML = html;
    const fresh = markupById(incoming);
    for (const node of [...incoming.querySelectorAll('[id]')]) {
      // An ancestor already kept its live element, and this one with it.
      if (!incoming.contains(node)) {
        continue;
      }
      const live = document.getElementById(node.id);
      if (live && element.contains(live) && rendered.get(node.id) === fresh.get(node.id)) {
        node.replaceWith(live);
      }
    }
    for (const [id, markup] of fresh) {
      rendered.set(id, markup);
    }
    const pageScroll = window.scrollY;
    element.replaceChildren(...incoming.childNodes);
    for (const [node, top, left] of scrolled) {
      // A pane whose content changed is a new element now; the one with its id takes the position.
      const target = node.isConnected ? node : node.id ? document.getElementById(node.id) : null;
      if (target) {
        target.scrollTop = top;
        target.scrollLeft = left;
      }
    }
    window.scrollTo(0, pageScroll);
  }

  /** The markup each element with an id was last rendered from, before anyone scrolled or opened anything in it. */
  const rendered = new Map();

  function markupById(root) {
    return new Map([...root.querySelectorAll('[id]')].map((node) => [node.id, node.outerHTML]));
  }

  function applyData(next) {
    if (!next || next.dir !== data.dir || next.generated === data.generated) {
      return;
    }
    data = next;
    indexData();
    if (state.open && !byId.has(state.open)) {
      state.open = null;
    }
    patchHtml(document.getElementById('app'), appHtml());
    document.body.classList.toggle('open', Boolean(state.open));
  }

  window.__updateEvaluatorReport = applyData;

  function loadLiveData() {
    if (!data.progress?.running) {
      return;
    }
    const script = document.createElement('script');
    script.src = `report-data.js?${Date.now()}`;
    script.async = true;
    script.onload = script.onerror = () => {
      script.remove();
      window.setTimeout(loadLiveData, 1000);
    };
    document.head.appendChild(script);
  }

  /* --------------------------------------------------------------- boot */

  document.getElementById('app').innerHTML = appHtml();
  for (const [id, markup] of markupById(document.getElementById('app'))) {
    rendered.set(id, markup);
  }
  document.body.classList.toggle('open', Boolean(state.open && byId.has(state.open)));

  const saved = localStorage.getItem('eval-theme');
  if (saved) {
    document.documentElement.dataset.theme = saved;
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('#theme')) {
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      const current = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('eval-theme', next);
      return;
    }
    const dot = event.target.closest('[data-trial]');
    if (dot) {
      open(dot.dataset.trial);
      return;
    }
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      step(Number(nav.dataset.nav));
      return;
    }
    if (event.target.closest('[data-close]') || event.target.id === 'scrim') {
      close();
      return;
    }
    const filter = event.target.closest('[data-filter]');
    if (filter) {
      state.filter = filter.dataset.filter;
      for (const button of document.querySelectorAll('[data-filter]')) {
        button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
      }
      renderList();
      remember();
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.id === 'case-filter') {
      state.case = event.target.value;
    } else if (event.target.id === 'arm-filter') {
      state.arm = event.target.value;
    } else {
      return;
    }
    renderList();
    remember();
  });

  document.addEventListener('input', (event) => {
    if (event.target.id === 'search') {
      state.query = event.target.value;
      renderList();
      remember();
    }
  });

  document.addEventListener('keydown', (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if (event.key === 'Escape') {
      if (typing) {
        event.target.blur();
      } else {
        close();
      }
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      step(1);
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'f') {
      state.filter = state.filter === 'fail' ? 'all' : 'fail';
      for (const button of document.querySelectorAll('[data-filter]')) {
        button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter));
      }
      renderList();
      remember();
    } else if (event.key === '/') {
      event.preventDefault();
      document.getElementById('search').focus();
    }
  });

  if (state.open) {
    open(state.open, false);
  }

  window.requestAnimationFrame(() => {
    window.scrollTo(0, Number(restored.pageScroll ?? 0));
    const drawer = document.getElementById('drawer');
    if (drawer) {
      drawer.scrollTop = Number(restored.drawerScroll ?? 0);
    }
  });

  if (data.progress?.running) {
    window.setTimeout(loadLiveData, 1000);
  }
})();
