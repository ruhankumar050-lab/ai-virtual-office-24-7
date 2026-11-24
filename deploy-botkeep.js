/**
 * Botkeep Cloud 1-Command Auto-Deployer
 * Usage:
 *   BOTKEEP_KEY="bk_live_..." node deploy-botkeep.js
 * Or pass --watch to retry every 60s until Botkeep free node capacity opens up!
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const API_BASE = 'https://api.botkeep.cloud/api/v1/developer';
const API_KEY = process.env.BOTKEEP_KEY || process.argv.find((a) => a.startsWith('bk_')) || '';
const WATCH = process.argv.includes('--watch');

if (!API_KEY) {
  console.error('❌ Please provide your Botkeep API key: BOTKEEP_KEY="bk_live_..." node deploy-botkeep.js');
  process.exit(1);
}

function idem() {
  return crypto.randomBytes(12).toString('hex');
}

async function api(method, endpoint, body = null, withIdem = false) {
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (withIdem) headers['Idempotency-Key'] = idem();

  const res = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, data: json };
}

function collectProjectFiles() {
  const files = [
    'package.json',
    'server.js',
    'public/index.html',
    'engine/agents.js',
    'engine/llm.js',
    'engine/orchestrator.js',
    'engine/storage.js',
    'engine/templates.js',
  ];
  return files
    .filter((f) => fs.existsSync(path.join(__dirname, f)))
    .map((f) => ({
      path: '/' + f,
      data: fs.readFileSync(path.join(__dirname, f)).toString('base64'),
      overwrite: true,
    }));
}

async function deployOnce() {
  console.log('🔍 Checking Botkeep account & existing workloads...');
  const listRes = await api('GET', '/workloads');
  if (!listRes.ok) {
    console.error('❌ Failed to list workloads:', listRes.status, listRes.data);
    return false;
  }

  let workload = (listRes.data.data || []).find((w) => w.name === 'ai-virtual-office') || (listRes.data.data || [])[0];

  if (!workload) {
    console.log('🚀 Creating Node.js 22 workload on Botkeep Cloud...');
    const createRes = await api(
      'POST',
      '/workloads',
      {
        name: 'ai-virtual-office',
        platform: 'general',
        runtime: 'nodejs',
        runtimeVersion: '22',
        sourceType: 'blank',
        startCommand: 'node server.js',
        resources: {
          memoryLimitMb: 512,
          cpuLimitPercent: 50,
          storageLimitMb: 1024,
        },
      },
      true
    );

    if (!createRes.ok) {
      console.warn(`⚠️ Botkeep returned HTTP ${createRes.status}:`, createRes.data.detail || createRes.data);
      return false;
    }

    const createdId = createRes.data?.workload?.id || createRes.data?.id;
    console.log('⏳ Waiting 5s for container provisioning...');
    await new Promise((r) => setTimeout(r, 5000));
    const afterList = await api('GET', '/workloads');
    workload = (afterList.data.data || []).find((w) => w.id === createdId || w.name === 'ai-virtual-office');
  }

  if (!workload) {
    console.error('❌ Workload created but not yet visible in list. Re-run script in 10 seconds.');
    return false;
  }

  const wid = workload.id;
  console.log(`📦 Uploading Virtual Office files to workload ${wid} (${workload.name})...`);
  const allFiles = collectProjectFiles();
  for (let i = 0; i < allFiles.length; i += 4) {
    const batch = allFiles.slice(i, i + 4);
    const upRes = await api('POST', `/workloads/${wid}/files/upload-batch`, { files: batch }, true);
    if (!upRes.ok) {
      console.error('❌ Upload batch failed:', upRes.status, upRes.data);
      return false;
    }
    console.log(`   ✅ Uploaded: ${batch.map((b) => b.path).join(', ')}`);
  }

  console.log('🌐 Enabling public HTTPS domain...');
  const domRes = await api('PUT', `/workloads/${wid}/domain`, { enabled: true }, true);
  console.log('   Domain config:', JSON.stringify(domRes.data));

  console.log('▶️ Starting AI Virtual Office server...');
  const startRes = await api('POST', `/workloads/${wid}/actions`, { action: 'start' }, true);
  console.log('   Start response:', startRes.status, JSON.stringify(startRes.data));

  const infoRes = await api('GET', `/workloads/${wid}`);
  const domainInfo = await api('GET', `/workloads/${wid}/domain`);
  console.log('\n🎉 Deployment Complete!');
  console.log('   Workload:', JSON.stringify(infoRes.data?.name || wid));
  console.log('   Public URL:', JSON.stringify(domainInfo.data));
  return true;
}

(async () => {
  const ok = await deployOnce();
  if (!ok && WATCH) {
    console.log('🔄 --watch enabled: retrying every 60 seconds until free capacity is available...');
    setInterval(async () => {
      const done = await deployOnce();
      if (done) process.exit(0);
    }, 60000);
  }
})();
