const { createMemoryStore } = require('./scoring/src/store');
const { createApp } = require('./scoring/src/app');
const { parseTokens } = require('./scoring/src/auth');
const { createOrchestrator, defaultVerifierRunner, PROJECT_ROOT } = require('./orchestrator/src');

const store = createMemoryStore();
for (const id of [1, 2, 3, 4]) {
  store.upsertTeam({ id, name: `Team ${id}`, pod_vlan: 100 + id, target_vlan: 200 + id,
    pod_subnet: `10.20.${id}.0/26`, target_subnet: `10.40.${id}.0/26` });
}
const round = store.createRound({ name: 'Round 1', image_set: 'golden-v3',
  starts_at: new Date(Date.now() - 600000).toISOString(), duration_minutes: 180,
  freeze_minutes: 15, team_ids: [1, 2, 3, 4] });
store.setRoundStatus(round.id, 'running');

const tokens = parseTokens({
  'tok-team-1': { role: 'competitor', team_id: 1 },
  'tok-judge': { role: 'judge' },
  'tok-admin': { role: 'admin' },
});
const orchestrator = createOrchestrator({ store, imageDir: require('node:os').tmpdir() });
const verifier = { run: () => defaultVerifierRunner({ root: PROJECT_ROOT }) };
createApp({ store, tokens, orchestrator, verifier })
  .listen(8080, '127.0.0.1', () => console.log('listening on 127.0.0.1:8080'));
