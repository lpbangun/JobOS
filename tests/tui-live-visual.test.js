import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTuiState, renderTui } from '../src/tui.js';

function boardModel() {
  return {
    generatedAt: '2026-01-01T12:00:00.000Z',
    empty: { noProfile: false, noJobs: false },
    jobs: [{
      id: 'job_visual_fixture',
      title: 'Fixture role',
      company: 'Fixture company',
      discoveryStatus: 'saved',
      signals: { artifacts: 0, contacts: 0 }
    }],
    review: [],
    selected: { docs: [], contacts: [] },
    onboarding: { steps: [] }
  };
}

test('B9 board pane tabs hug their content instead of stretching across the main pane', () => {
  const state = {
    ...defaultTuiState(),
    welcomeDismissed: true,
    selectedJobId: 'job_visual_fixture'
  };
  const text = renderTui(boardModel(), state, { width: 140, height: 42, color: false });
  assert.doesNotMatch(text, /WELCOME TO JOBOS/i, 'fixture renders the board with no covering overlay');

  const navLine = text.split('\n').find(line =>
    /\bNew\b.*\bJobs\b.*\bJob\b.*\bPeople\b.*\bChat\b/.test(line)
  );
  assert.ok(navLine, 'board paints the rail segments and Job | People | Chat pane tabs');

  const jobsAt = navLine.indexOf('Jobs');
  const jobAt = navLine.indexOf('Job', jobsAt + 'Jobs'.length);
  const peopleAt = navLine.indexOf('People', jobAt + 'Job'.length);
  const chatAt = navLine.indexOf('Chat', peopleAt + 'People'.length);
  const jobGap = peopleAt - jobAt;
  const peopleGap = chatAt - peopleAt;

  assert.ok(
    jobGap <= 12 && peopleGap <= 12,
    `pane tabs must be fixed/compact (maximum 12 columns between labels); observed gaps ${jobGap} and ${peopleGap}: ${navLine.trim()}`
  );
});
