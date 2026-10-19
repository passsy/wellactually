import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { opener } from './open-report.ts';
import { writePage } from './page.ts';

const ROW = {
  harness: 'codex',
  requestedModel: 'gpt-test',
  model: 'gpt-test',
  effort: 'xhigh',
  case: 'PW-X001/example/action',
  axis: 'action',
  arm: 'plugin',
  ran: 0,
  passed: 0,
  errors: 0,
  detail: '',
};

interface PageData {
  environment: { harness: string; requested: string; effort: string }[];
  progress: {
    completed: number;
    total: number;
    running: boolean;
    active?: { case: string; arm: string; n: number }[];
  };
  alerts: { title: string }[];
}

test('the report opens with the platform launcher', () => {
  assert.deepEqual(opener('darwin', '/tmp/report.html'), {
    command: 'open',
    args: ['/tmp/report.html'],
  });
  assert.deepEqual(opener('win32', 'C:\\report.html'), {
    command: 'cmd',
    args: ['/c', 'start', '', 'C:\\report.html'],
  });
  assert.deepEqual(opener('linux', '/tmp/report.html'), {
    command: 'xdg-open',
    args: ['/tmp/report.html'],
  });
});

test('a running report carries progress and suppresses final-run warnings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wellactually-evaluator-page-'));
  writeFileSync(
    join(dir, 'results.json'),
    JSON.stringify({
      options: { arms: [{ name: 'plugin', kind: 'plugin' }], n: 3 },
      environment: [{ harness: 'codex', requested: 'gpt-test', effort: 'xhigh' }],
      judge: 'judge-test',
      progress: {
        completed: 0,
        total: 3,
        running: true,
        active: [
          {
            harness: 'codex',
            requestedModel: 'gpt-test',
            effort: 'xhigh',
            case: 'PW-X001/example/action',
            arm: 'plugin',
            n: 1,
          },
        ],
      },
      rows: [ROW],
      results: [],
    }),
  );

  const path = writePage(dir);
  const html = readFileSync(path, 'utf8');
  const data = pageData(path);

  assert.equal(data.progress.completed, 0);
  assert.equal(data.progress.total, 3);
  assert.equal(data.progress.running, true);
  assert.deepEqual(data.progress.active?.map(({ case: caseId, arm, n }) => ({ case: caseId, arm, n })), [
    { case: 'PW-X001/example/action', arm: 'plugin', n: 1 },
  ]);
  assert.deepEqual(data.alerts, []);
  assert.doesNotMatch(html, /location\.reload\(\)/);
  assert.match(html, /morphdom\(element, incoming, morphOptions\)/);
  assert.match(html, /script\.src = `report-data\.js\?\$\{Date\.now\(\)\}`/);
  assert.match(
    readFileSync(join(dir, 'report-data.js'), 'utf8'),
    /^window\.__updateEvaluatorReport\?\.\(/,
  );
  assert.match(html, /class="dot \$\{running \? 'running' : 'pending'\}"/);
  assert.match(html, /trial \$\{n\} · \$\{/);
  assert.match(html, /aria-label="Trial states"/);
  assert.match(html, /class="verdict \$\{trial\.status\} judge-verdict"/);
  assert.match(html, /Raw JSON response/);
  assert.match(html, /Whole judge prompt/);
  assert.match(html, /row\.passed}\/\${planned}/);
  assert.match(
    html,
    /trialsPerCell \* cellRows\(caseId, arm, configuration\)\.length/,
  );
  assert.match(html, /window\.name = JSON\.stringify/);
  assert.match(html, /Models under evaluation/);
  assert.match(html, /class="model-name"/);
  assert.deepEqual(data.environment, [
    { harness: 'codex', requested: 'gpt-test', effort: 'xhigh' },
  ]);
  assert.match(html, /configurationKey\(row\) === configurationKey\(configuration\)/);
  assert.match(html, /model-effort/);
  assert.equal(existsSync(`${path}.next`), false);
  assert.equal(existsSync(join(dir, 'report-data.js.next')), false);
});

test('the final snapshot stops polling and restores result warnings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wellactually-evaluator-page-'));
  writeFileSync(
    join(dir, 'results.json'),
    JSON.stringify({
      options: { arms: [{ name: 'plugin', kind: 'plugin' }], n: 3 },
      judge: 'judge-test',
      progress: { completed: 3, total: 3, running: false },
      rows: [ROW],
      results: [],
    }),
  );

  const path = writePage(dir);
  const html = readFileSync(path, 'utf8');
  const data = pageData(path);

  assert.equal(data.progress.running, false);
  assert.equal(data.alerts.some((alert) => alert.title.includes('produced no usable trial')), true);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
});

function pageData(path: string): PageData {
  const html = readFileSync(path, 'utf8');
  const match = /<script type="application\/json" id="run-data">(.+)<\/script>/.exec(html);
  assert.ok(match?.[1]);
  return JSON.parse(match[1]) as PageData;
}
