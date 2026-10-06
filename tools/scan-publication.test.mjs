import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reconcileScan } from './scan-publication.mjs'

const mod = (repo, extra = {}) => ({ id: `${repo}:.`, repo, kind: 'mod', name: repo.split('/')[1], path: '.', description: 'A mod.', url: `https://github.com/${repo}`, stars: 1, reach: { level: 0, labels: [] }, sees: [], hooks: [], calls: [], surfaceModules: [], validate: { status: 'passed', claudeVersion: '2.1.287', errors: [] }, ...extra })
const inventory = mods => ({ generated: '2026-01-01T00:00:00Z', claudeVersion: '2.1.287', repos: new Set(mods.map(m => m.repo)).size, mods })
const repos = data => [...new Set(data.mods.map(m => m.repo))]
const merge = (before, scan, latest, seeds = []) => reconcileScan(before, scan, latest, repos(before), repos(scan), repos(latest), seeds)

test('concurrent published records win by repository while other scanned records advance', () => {
  const before = inventory([mod('o/old'), mod('o/stable')])
  const scan = inventory([mod('o/old', { description: 'Stale scan.' }), mod('o/stable', { description: 'Fresh scan.' }), mod('o/discovered')])
  const latest = inventory([mod('o/old', { description: 'Newer publication.' }), mod('o/stable'), mod('o/seed')])
  const original = structuredClone(latest)
  const result = merge(before, scan, latest, ['o/unscanned'])
  assert.deepEqual(result.inventory.mods.map(m => [m.repo, m.description]), [['o/discovered', 'A mod.'], ['o/old', 'Newer publication.'], ['o/seed', 'A mod.'], ['o/stable', 'Fresh scan.']])
  assert.ok(result.repos.includes('o/unscanned'))
  assert.equal(result.inventory.repos, 5)
  assert.deepEqual(latest, original)
})

test('a concurrent retirement does not resurrect a removed plugin or its candidate repo', () => {
  const before = inventory([mod('o/retired'), mod('o/partial'), mod('o/partial', { id: 'o/partial:removed' })])
  const scan = structuredClone(before)
  const latest = inventory([mod('o/partial')])
  assert.deepEqual(merge(before, scan, latest).inventory.mods, latest.mods)
  assert.deepEqual(merge(before, scan, latest).repos, ['o/partial'])
})

test('a new main repository supersedes a scan copy, including all of its plugins', () => {
  const latest = inventory([mod('o/new'), mod('o/new', { id: 'o/new:second' })])
  const result = merge(inventory([]), inventory([mod('o/new', { description: 'Old.' })]), latest)
  assert.deepEqual(result.inventory.mods, latest.mods)
})

test('validator conflicts and broken duplicate targets require a fresh scan', () => {
  assert.throws(() => merge(inventory([]), inventory([]), inventory([mod('o/new', { validate: { status: 'passed', claudeVersion: '2.1.288' } })])), /different validator/)
  const before = inventory([mod('o/keeper')])
  const scan = inventory([...before.mods, mod('o/copy', { kind: 'duplicate', duplicateOf: 'o/keeper:.' })])
  assert.throws(() => merge(before, scan, inventory([])), /Duplicate keeper changed/)
})

test('concurrent additions cannot disguise a partial scan or roll back a newer full scan', () => {
  const before = inventory(Array.from({ length: 6 }, (_, i) => mod(`o/old${i}`)))
  const latest = inventory([...before.mods, ...Array.from({ length: 20 }, (_, i) => mod(`o/new${i}`))])
  assert.throws(() => merge(before, inventory(before.mods.slice(0, 2)), latest), /scan looks partial/)
  assert.throws(() => merge(before, before, { ...before, generated: '2026-01-02T00:00:00Z' }), /newer full scan/)
})

test('repository casing and record order alone do not change the reconciliation decision', () => {
  const before = inventory([mod('O/Repo'), mod('O/Repo', { id: 'O/Repo:two' })])
  const scan = inventory([mod('O/Repo', { description: 'Fresh.' }), before.mods[1]])
  const latest = inventory([...before.mods].reverse())
  assert.equal(merge(before, scan, latest).inventory.mods[0].description, 'Fresh.')
})

test('scan publication retries concurrent merges and refreshes the open PR without rescanning', t => {
  const root = mkdtempSync(join(tmpdir(), 'scan-publication-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const remote = join(root, 'remote.git'), checkout = join(root, 'checkout'), bin = join(root, 'bin'), runner = join(root, 'runner')
  for (const dir of [checkout, bin, runner]) mkdirSync(dir)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
  const git = (...args) => execFileSync('git', args, { cwd: checkout, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--bare', remote)
  git('init', '-b', 'fixture')
  git('remote', 'add', 'origin', remote)
  cpSync(fileURLToPath(new URL('.', import.meta.url)), join(checkout, 'tools'), { recursive: true })
  mkdirSync(join(checkout, 'data'))
  const before = inventory([mod('o/old')])
  writeFileSync(join(checkout, 'data/mods.json'), JSON.stringify(before))
  writeFileSync(join(checkout, 'data/repos.txt'), 'o/old\n')
  writeFileSync(join(checkout, 'data/seeds.txt'), 'o/old\n')
  writeFileSync(join(checkout, 'data/discovery.json'), '{}')
  writeFileSync(join(checkout, 'README.md'), 'Curated original.\n<!-- stats:start -->\n<!-- stats:end -->\n')
  writeFileSync(join(checkout, 'catalogue.md'), ['stats', 'scan', 'builtin'].map(name => `<!-- ${name}:start -->\n<!-- ${name}:end -->`).join('\n'))
  execFileSync(process.execPath, ['tools/render.mjs'], { cwd: checkout, env })
  git('add', '.')
  git('commit', '-m', 'Fixture inventory')
  git('push', 'origin', 'HEAD:main')
  const originalMain = git('rev-parse', 'HEAD')
  writeFileSync(join(checkout, 'data/mods.json'), JSON.stringify(inventory([mod('o/old', { description: 'Scanned.' }), mod('o/discovered')])))
  writeFileSync(join(checkout, 'data/repos.txt'), 'o/old\no/discovered\n')
  const log = join(root, 'commands.jsonl'), marker = join(root, 'advanced'), pr = join(root, 'pr'), other = join(root, 'contributor')
  const prelude = `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify([require('node:path').basename(process.argv[1]),...args])+'\\n');const git=(...a)=>cp.execFileSync('git',a,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();\n`
  writeFileSync(join(bin, 'npm'), prelude + `
if(args.join(' ')==='run render')cp.execFileSync(process.execPath,['tools/render.mjs'],{stdio:'pipe'});
if(args.join(' ')==='run lint'){git('rev-parse','--abbrev-ref','@{upstream}');if(process.env.FAIL_LINT)process.exit(1);}
`, { mode: 0o755 })
  writeFileSync(join(bin, 'gh'), prelude + `
if(args[0]==='api'){
  if(!fs.existsSync(${JSON.stringify(marker)})){
    fs.writeFileSync(${JSON.stringify(marker)},'yes');
    git('clone','--branch','main',${JSON.stringify(remote)},${JSON.stringify(other)});
    fs.appendFileSync(${JSON.stringify(other + '/data/seeds.txt')},'o/later\\n');
    fs.appendFileSync(${JSON.stringify(other + '/README.md')},'Contributor entry.\\n');
    const data=JSON.parse(fs.readFileSync(${JSON.stringify(other + '/data/mods.json')}));
    data.mods.push(${JSON.stringify(mod('o/published'))});
    fs.writeFileSync(${JSON.stringify(other + '/data/mods.json')},JSON.stringify(data));
    git('-C',${JSON.stringify(other)},'switch','-c','contributor');git('-C',${JSON.stringify(other)},'add','.');git('-C',${JSON.stringify(other)},'commit','-m','Concurrent publication');git('-C',${JSON.stringify(other)},'push','origin','HEAD:main');
  }
  console.log(git('--git-dir',${JSON.stringify(remote)},'rev-parse','main'));
}else if(args[1]==='list'){if(fs.existsSync(${JSON.stringify(pr)}))console.log('1');
}else if(args[1]==='create'||args[1]==='edit'){fs.copyFileSync(args[args.indexOf('--body-file')+1],${JSON.stringify(pr)});
  if(args[1]==='create'){
    fs.appendFileSync(${JSON.stringify(other + '/README.md')},'Merged after PR creation.\\n');
    git('-C',${JSON.stringify(other)},'add','.');git('-C',${JSON.stringify(other)},'commit','-m','Merge after publication');git('-C',${JSON.stringify(other)},'push','origin','HEAD:main');
  }
}else if(args[1]==='view'){console.log('OPEN');
}else if(args[1]==='close'){fs.unlinkSync(${JSON.stringify(pr)});
}else{throw Error('Unexpected gh call '+args.join(' '));}
`, { mode: 0o755 })
  const runEnv = { ...env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runner, GITHUB_REPOSITORY: 'example/mods', GITHUB_RUN_ID: '1' }
  const run = (...args) => execFileSync('bash', ['tools/publish-scan.sh', ...args], { cwd: checkout, env: runEnv, stdio: 'pipe' })
  run()
  const proposed = () => JSON.parse(git('--git-dir', remote, 'show', 'nightly-scan:data/mods.json'))
  assert.deepEqual(proposed().mods.map(m => m.repo), ['o/discovered', 'o/old', 'o/published'])
  assert.match(git('--git-dir', remote, 'show', 'nightly-scan:README.md'), /Contributor entry/)
  assert.match(git('--git-dir', remote, 'show', 'nightly-scan:data/seeds.txt'), /o\/later/)
  assert.equal(git('--git-dir', remote, 'rev-parse', 'nightly-scan^'), git('--git-dir', remote, 'rev-parse', 'main'))
  assert.notEqual(git('--git-dir', remote, 'rev-parse', 'main'), originalMain)
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls().filter(call => call.join(' ') === 'npm run render').length, 3)
  assert.match(git('--git-dir', remote, 'show', 'nightly-scan:README.md'), /Merged after PR creation/)

  writeFileSync(join(other, 'README.md'), readFileSync(join(other, 'README.md'), 'utf8') + 'Another contributor.\n')
  git('-C', other, 'add', '.')
  git('-C', other, 'commit', '-m', 'Later contributor merge')
  git('-C', other, 'push', 'origin', 'HEAD:main')
  const checkedHead = git('--git-dir', remote, 'rev-parse', 'nightly-scan')
  const failed = spawnSync('bash', ['tools/publish-scan.sh', '--refresh'], { cwd: checkout, env: { ...runEnv, FAIL_LINT: '1' }, encoding: 'utf8' })
  assert.notEqual(failed.status, 0)
  assert.equal(git('--git-dir', remote, 'rev-parse', 'nightly-scan'), checkedHead, 'failed checks cannot replace the reviewed head')
  run('--refresh')
  assert.match(git('--git-dir', remote, 'show', 'nightly-scan:README.md'), /Another contributor/)
  assert.equal(git('--git-dir', remote, 'rev-parse', 'nightly-scan^'), git('--git-dir', remote, 'rev-parse', 'main'))
  const count = calls().length
  run('--refresh')
  assert.ok(!calls().slice(count).some(call => call[0] === 'npm'), 'up-to-date refresh skips all expensive checks')
  assert.ok(!calls().some(call => call.slice(0, 3).join(' ') === 'npm run scan' || call.slice(0, 3).join(' ') === 'gh pr merge'), 'no new scan or automatic merge')

  writeFileSync(join(other, 'tools/scan.mjs'), '// changed scanner\n')
  git('-C', other, 'add', '.')
  git('-C', other, 'commit', '-m', 'Change scanner')
  git('-C', other, 'push', 'origin', 'HEAD:main')
  const priorHead = git('--git-dir', remote, 'rev-parse', 'nightly-scan')
  const blocked = spawnSync('bash', ['tools/publish-scan.sh', '--refresh'], { cwd: checkout, env: runEnv, encoding: 'utf8' })
  assert.notEqual(blocked.status, 0)
  assert.match(blocked.stderr, /Scanner inputs changed/)
  assert.equal(git('--git-dir', remote, 'rev-parse', 'nightly-scan'), priorHead)
})
