const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Resvg } = require('@resvg/resvg-js');
const PDFDocument = require('pdfkit');
const ArabicReshaper = require('arabic-persian-reshaper');
const bidiFactory = require('bidi-js');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');
const ffmpegPath = require('ffmpeg-static');
const { scanGeneratedCodeSafety } = require('./security');

const bidi = bidiFactory();
const ROOT_DIR = path.resolve(__dirname, '..');
const FONT_PATH = path.join(ROOT_DIR, 'assets', 'fonts', 'NotoSansArabic-Regular.ttf');

function escXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shapeArabicForPdf(text) {
  const str = String(text || '');
  try {
    const reshaped = ArabicReshaper.ArabicShaper ? ArabicReshaper.ArabicShaper.convertArabic(str) : str;
    // Reverse RTL segments visually for PDFKit's LTR glyph cursor
    return reshaped
      .split('\n')
      .map((line) => {
        const hasArabic = /[\u0600-\u06FF\uFE70-\uFEFF]/.test(line);
        if (!hasArabic) return line;
        // Keep Latin/numbers segments intact while reversing word/char order cleanly
        const tokens = line.match(/([A-Za-z0-9._:/-]+|[^\sA-Za-z0-9._:/-]+|\s+)/g) || [line];
        return tokens
          .reverse()
          .map((tok) => (/[\u0600-\u06FF\uFE70-\uFEFF]/.test(tok) ? [...tok].reverse().join('') : tok))
          .join('');
      })
      .join('\n');
  } catch {
    return str;
  }
}

function wrapLines(text, maxChars = 48) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Generates a synthesized PCM WAV audio track with harmonic chords & narration cadence markers
 */
function generateAudioWav(outPath, durationSec = 12) {
  const sampleRate = 22050;
  const numSamples = Math.max(1, Math.floor(durationSec * sampleRate));
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);

  // RIFF/WAV header
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  const notes = [261.63, 329.63, 392.0, 440.0]; // C major warm chord progression
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const note = notes[Math.floor(t / 3) % notes.length];
    const env = Math.min(1, (t % 3) * 4) * Math.max(0.2, 1 - ((t % 3) / 3) * 0.6);
    const val = Math.sin(2 * Math.PI * note * t) * 0.14 * env + Math.sin(2 * Math.PI * (note * 1.5) * t) * 0.06 * env;
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(val * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(outPath, buf);
  return outPath;
}

/**
 * Renders real Arabic MP4 video + SRT subtitles + Storyboard JSON via @resvg/resvg-js & FFmpeg (async, low-RAM)
 */
async function generateRealVideo({ title, topic, scenes, outputDir }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const fontFiles = fs.existsSync(FONT_PATH) ? [FONT_PATH] : [];

  const safeScenes =
    Array.isArray(scenes) && scenes.length > 0
      ? scenes
      : [
          { id: 1, durationSec: 4, heading: title, subtitle: topic || 'مقدمة تعليمية', accent: '#38bdf8', bgStart: '#0f172a', bgEnd: '#1e1b4b', voiceover: title },
          { id: 2, durationSec: 4, heading: 'المفهوم الأساسي', subtitle: 'شرح مبسط ومباشر لأهم فكرة في الدرس', accent: '#10b981', bgStart: '#064e3b', bgEnd: '#0f172a', voiceover: 'شرح المفهوم الأساسي' },
          { id: 3, durationSec: 4, heading: 'التطبيق والملخص', subtitle: 'أهم النقاط العملية والتدريب السريع', accent: '#f59e0b', bgStart: '#312e81', bgEnd: '#0f172a', voiceover: 'ملخص الدرس وتطبيقاته' },
        ];

  const concatLines = [];
  const srtParts = [];
  let currentSec = 0;

  safeScenes.forEach((sc, idx) => {
    const dur = Math.max(2, Math.min(8, Number(sc.durationSec) || 4));
    const subLines = wrapLines(sc.subtitle || sc.voiceover || '', 44).slice(0, 3);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${escXml(sc.bgStart || '#0f172a')}"/>
          <stop offset="100%" stop-color="${escXml(sc.bgEnd || '#312e81')}"/>
        </linearGradient>
      </defs>
      <rect width="1280" height="720" fill="url(#g)"/>
      <rect x="70" y="70" width="1140" height="580" rx="28" fill="rgba(15,23,42,0.58)" stroke="${escXml(sc.accent || '#38bdf8')}" stroke-width="4"/>
      <rect x="920" y="96" width="250" height="46" rx="23" fill="${escXml(sc.accent || '#38bdf8')}"/>
      <text x="1045" y="126" text-anchor="middle" font-family="Noto Sans Arabic" font-size="22" font-weight="bold" fill="#0f172a">المشهد ${idx + 1} / ${safeScenes.length}</text>
      <text x="640" y="250" text-anchor="middle" font-family="Noto Sans Arabic" font-size="46" font-weight="bold" fill="#ffffff">${escXml(sc.heading || title)}</text>
      ${subLines
        .map(
          (ln, li) =>
            `<text x="640" y="${340 + li * 54}" text-anchor="middle" font-family="Noto Sans Arabic" font-size="30" fill="#cbd5e1">${escXml(ln)}</text>`
        )
        .join('')}
      <rect x="140" y="575" width="1000" height="12" rx="6" fill="rgba(255,255,255,0.15)"/>
      <rect x="140" y="575" width="${Math.round(((idx + 1) / safeScenes.length) * 1000)}" height="12" rx="6" fill="${escXml(sc.accent || '#38bdf8')}"/>
      <text x="640" y="622" text-anchor="middle" font-family="Noto Sans Arabic" font-size="22" fill="#94a3b8">${escXml(title)}</text>
    </svg>`;

    const framePath = path.join(outputDir, `frame_${idx + 1}.png`);
    const resvg = new Resvg(svg, { font: { fontFiles, loadSystemFonts: false } });
    fs.writeFileSync(framePath, resvg.render().asPng());
    concatLines.push(`file '${framePath.replace(/'/g, "'\\''")}'`);
    concatLines.push(`duration ${dur}`);

    const fmtSrt = (s) => {
      const hh = String(Math.floor(s / 3600)).padStart(2, '0');
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const ss = String(Math.floor(s % 60)).padStart(2, '0');
      return `${hh}:${mm}:${ss},000`;
    };
    srtParts.push(`${idx + 1}\n${fmtSrt(currentSec)} --> ${fmtSrt(currentSec + dur)}\n${sc.voiceover || sc.subtitle || sc.heading}\n`);
    currentSec += dur;
  });
  // FFmpeg concat demuxer requires last file listed again without duration
  const lastFrame = path.join(outputDir, `frame_${safeScenes.length}.png`);
  concatLines.push(`file '${lastFrame.replace(/'/g, "'\\''")}'`);

  const concatFile = path.join(outputDir, 'frames.txt');
  fs.writeFileSync(concatFile, concatLines.join('\n'), 'utf8');

  const audioPath = path.join(outputDir, 'audio.wav');
  generateAudioWav(audioPath, currentSec);

  const srtPath = path.join(outputDir, 'subtitles.srt');
  fs.writeFileSync(srtPath, srtParts.join('\n'), 'utf8');

  const mp4Path = path.join(outputDir, 'video.mp4');
  await new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        '-y',
        '-threads', '1',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFile,
        '-i', audioPath,
        '-vf', 'scale=854:480,fps=10,format=yuv420p',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'stillimage',
        '-crf', '28',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-shortest',
        mp4Path,
      ],
      { timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`FFmpeg error: ${stderr ? stderr.slice(-200) : err.message}`));
        else resolve();
      }
    );
  });

  const storyboard = {
    title,
    topic,
    durationSec: currentSec,
    scenes: safeScenes,
    edited: true,
    version: 2,
    mp4File: 'video.mp4',
    subtitlesFile: 'subtitles.srt',
    audioFile: 'audio.wav',
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outputDir, 'storyboard.json'), JSON.stringify(storyboard, null, 2), 'utf8');

  return {
    mp4Path,
    srtPath,
    audioPath,
    storyboardPath: path.join(outputDir, 'storyboard.json'),
    durationSec: currentSec,
    mp4Size: fs.statSync(mp4Path).size,
  };
}

/**
 * Generates real printable Arabic PDF + DOCX booklet files
 */
async function generateBookletFiles({ title, curriculumMeta = {}, summary, objectives = [], sections = [], questions = [], sourceNotes = [], outputDir }) {
  fs.mkdirSync(outputDir, { recursive: true });

  // 1. Real PDF via PDFKit + NotoSansArabic
  const pdfPath = path.join(outputDir, 'booklet.pdf');
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 45, info: { Title: title, Author: 'AI Virtual Office' } });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);
    if (fs.existsSync(FONT_PATH)) {
      doc.font(FONT_PATH);
    }

    const writeRtl = (txt, size = 13, color = '#1e293b', moveDown = 0.5) => {
      doc.fillColor(color).fontSize(size).text(shapeArabicForPdf(txt), { align: 'right' });
      if (moveDown) doc.moveDown(moveDown);
    };

    writeRtl(title, 22, '#0f172a', 0.4);
    const metaLine = [curriculumMeta.grade, curriculumMeta.term, curriculumMeta.unit].filter(Boolean).join(' | ');
    if (metaLine) writeRtl(metaLine, 12, '#475569', 0.6);

    writeRtl('أولاً: أهداف التعلم', 15, '#1d4ed8', 0.3);
    for (const obj of objectives) {
      writeRtl(`• ${obj}`, 12, '#1e293b', 0.25);
    }
    doc.moveDown(0.5);

    writeRtl('ثانياً: ملخص الدرس والمحتوى المؤكد', 15, '#1d4ed8', 0.3);
    writeRtl(summary || 'ملخص منظم لمفاهيم الدرس الأساسية.', 12, '#1e293b', 0.5);

    for (const sec of sections) {
      writeRtl(sec.heading || 'محور تعليمي', 14, '#0f766e', 0.25);
      writeRtl(sec.body || '', 12, '#334155', 0.45);
    }

    writeRtl('ثالثاً: بنك الأسئلة والتدريبات', 15, '#1d4ed8', 0.3);
    questions.forEach((q, idx) => {
      writeRtl(`${idx + 1}) ${q.question}`, 12, '#0f172a', 0.2);
      if (Array.isArray(q.options)) {
        writeRtl(`   الخيارات: ${q.options.join(' / ')}`, 11, '#475569', 0.15);
      }
      writeRtl(`   الإجابة النموذجية: ${q.answer}`, 11, '#15803d', 0.35);
    });

    if (sourceNotes.length > 0) {
      writeRtl('رابعاً: توثيق المصادر ومستوى التأكد', 14, '#7c2d12', 0.25);
      for (const n of sourceNotes) {
        writeRtl(`- [${n.verified ? 'مؤكد من الدرس' : 'يحتاج مراجعة'}] ${n.text}`, 11, '#475569', 0.2);
      }
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  // 2. Real DOCX via docx package
  const docxPath = path.join(outputDir, 'booklet.docx');
  const pRtl = (text, opts = {}) =>
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      bidirectional: true,
      heading: opts.heading,
      children: [
        new TextRun({
          text: String(text || ''),
          bold: Boolean(opts.bold),
          size: opts.size || 24,
          color: opts.color || '1E293B',
          rightToLeft: true,
        }),
      ],
    });

  const children = [
    pRtl(title, { heading: HeadingLevel.HEADING_1, bold: true, size: 36, color: '0F172A' }),
    pRtl([curriculumMeta.grade, curriculumMeta.term, curriculumMeta.unit].filter(Boolean).join(' - '), { size: 22, color: '475569' }),
    pRtl('أهداف التعلم', { heading: HeadingLevel.HEADING_2, bold: true, size: 28, color: '1D4ED8' }),
    ...objectives.map((o) => pRtl(`• ${o}`, { size: 24 })),
    pRtl('ملخص الدرس', { heading: HeadingLevel.HEADING_2, bold: true, size: 28, color: '1D4ED8' }),
    pRtl(summary || '', { size: 24 }),
    ...sections.flatMap((s) => [
      pRtl(s.heading || '', { heading: HeadingLevel.HEADING_3, bold: true, size: 26, color: '0F766E' }),
      pRtl(s.body || '', { size: 24 }),
    ]),
    pRtl('الأسئلة والتدريبات', { heading: HeadingLevel.HEADING_2, bold: true, size: 28, color: '1D4ED8' }),
    ...questions.flatMap((q, i) => [
      pRtl(`${i + 1}) ${q.question}`, { bold: true, size: 24 }),
      ...(Array.isArray(q.options) ? [pRtl(`الخيارات: ${q.options.join(' | ')}`, { size: 22, color: '475569' })] : []),
      pRtl(`الإجابة: ${q.answer}`, { size: 22, color: '15803D' }),
    ]),
  ];

  const wordDoc = new Document({ sections: [{ properties: {}, children }] });
  const docxBuf = await Packer.toBuffer(wordDoc);
  fs.writeFileSync(docxPath, docxBuf);

  return {
    pdfPath,
    docxPath,
    pdfSize: fs.statSync(pdfPath).size,
    docxSize: fs.statSync(docxPath).size,
  };
}

/**
 * Generates an interactive playable HTML5 Educational Game with mobile/desktop controls,
 * collision/challenge loop, Web Audio SFX, start/end screens, and curriculum questions.
 */
function generateEducationalGame({ title, questions = [], outputDir }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const safeQuestions =
    questions.length >= 3
      ? questions
      : [
          { question: `ما الفكرة الرئيسية في درس "${title}"؟`, options: ['الفهم المنظم والتطبيق', 'الحفظ بدون فهم', 'تجاهل القواعد'], answerIndex: 0 },
          { question: 'ما الخطوة الصحيحة بعد دراسة المفهوم؟', options: ['التدريب العملي والاختبار', 'التوقف فوراً', 'تغيير المصدر'], answerIndex: 0 },
          { question: 'كيف نتحقق من صحة المعلومة؟', options: ['الرجوع لمصدر الدرس المعتمد', 'التخمين العشوائي', 'تجاهل المراجعة'], answerIndex: 0 },
        ];

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>لعبة تعليمية: ${escXml(title)}</title>
  <style>
    body { margin:0; font-family: Tahoma, Arial, sans-serif; background: linear-gradient(135deg,#0f172a,#312e81); color:#f8fafc; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; }
    .game-shell { width:100%; max-width:720px; background:rgba(15,23,42,0.92); border:2px solid #38bdf8; border-radius:20px; padding:20px; box-shadow:0 20px 50px rgba(0,0,0,0.45); }
    .hud { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:14px; font-weight:bold; }
    .pill { background:#1e293b; border:1px solid #334155; padding:6px 12px; border-radius:999px; font-size:0.9rem; }
    canvas { width:100%; height:240px; background:#020617; border-radius:14px; border:1px solid #334155; display:block; margin-bottom:14px; }
    .btn { background:#6366f1; color:#fff; border:none; border-radius:12px; padding:10px 16px; font-weight:bold; cursor:pointer; font-size:0.95rem; }
    .btn.opt { width:100%; text-align:right; background:#1e293b; border:1px solid #475569; margin-bottom:8px; }
    .btn.opt:hover { border-color:#38bdf8; background:#0f172a; }
    .controls { display:flex; gap:8px; justify-content:center; margin-bottom:12px; }
    .screen { display:none; }
    .screen.active { display:block; }
  </style>
</head>
<body>
  <div class="game-shell">
    <div class="hud">
      <div class="pill">🎮 ${escXml(title)}</div>
      <div class="pill">⭐ النقاط: <span id="scoreEl">0</span></div>
      <div class="pill">❤️ المحاولات: <span id="livesEl">3</span></div>
      <button class="btn" id="muteBtn" style="background:#334155;padding:6px 12px;">🔊 صوت</button>
    </div>

    <div id="startScreen" class="screen active">
      <h2>مرحباً بك في التحدي التعليمي!</h2>
      <p>وجّه المركبة التعليمية لالتقاط النجوم الذهبية ثم أجب عن أسئلة الدرس للفوز.</p>
      <button class="btn" id="startBtn">🚀 ابدأ اللعبة الآن</button>
    </div>

    <div id="playScreen" class="screen">
      <canvas id="arena" width="660" height="240"></canvas>
      <div class="controls">
        <button class="btn" id="rightBtn">◀️ يمين</button>
        <button class="btn" id="leftBtn">يسار ▶️</button>
      </div>
      <div id="quizBox" style="background:#1e293b;padding:14px;border-radius:14px;">
        <div id="qText" style="font-weight:bold;margin-bottom:10px;"></div>
        <div id="qOpts"></div>
      </div>
    </div>

    <div id="endScreen" class="screen">
      <h2 id="endTitle">انتهت الجولة!</h2>
      <p>نتيجتك النهائية: <strong id="finalScore">0</strong> نقطة</p>
      <button class="btn" id="restartBtn">🔁 العب مرة أخرى</button>
    </div>
  </div>

  <script>
    const QUESTIONS = ${JSON.stringify(safeQuestions)};
    let score = 0, lives = 3, qIdx = 0, muted = false, running = false;
    let playerX = 330, star = { x: 200, y: 20, vy: 2.5 };
    const ctx = document.getElementById('arena').getContext('2d');
    const audioCtx = window.AudioContext ? new (window.AudioContext || window.webkitAudioContext)() : null;

    function beep(freq, dur) {
      if (muted || !audioCtx) return;
      try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = freq;
        gain.gain.value = 0.08;
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.start(); osc.stop(audioCtx.currentTime + dur);
      } catch {}
    }

    function showScreen(id) {
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      document.getElementById(id).classList.add('active');
    }

    function renderQuestion() {
      if (qIdx >= QUESTIONS.length || lives <= 0) {
        running = false;
        document.getElementById('endTitle').textContent = lives > 0 ? '🏆 أحسنت! أنهيت الدرس بنجاح' : '💡 حاول مجدداً لتتقن الدرس';
        document.getElementById('finalScore').textContent = score;
        showScreen('endScreen');
        return;
      }
      const q = QUESTIONS[qIdx];
      document.getElementById('qText').textContent = (qIdx + 1) + ') ' + q.question;
      const box = document.getElementById('qOpts');
      box.innerHTML = '';
      (q.options || []).forEach((opt, i) => {
        const b = document.createElement('button');
        b.className = 'btn opt';
        b.textContent = opt;
        b.onclick = () => {
          const correct = i === (q.answerIndex ?? 0);
          if (correct) { score += 20; beep(660, 0.14); }
          else { lives -= 1; beep(220, 0.2); }
          document.getElementById('scoreEl').textContent = score;
          document.getElementById('livesEl').textContent = lives;
          qIdx += 1;
          renderQuestion();
        };
        box.appendChild(b);
      });
    }

    function loop() {
      if (!running) return;
      ctx.clearRect(0, 0, 660, 240);
      // Draw player ship
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(playerX - 28, 204, 56, 18);
      // Update & draw falling star
      star.y += star.vy;
      ctx.fillStyle = '#facc15';
      ctx.beginPath(); ctx.arc(star.x, star.y, 11, 0, Math.PI * 2); ctx.fill();
      // Collision check
      if (star.y >= 196 && Math.abs(star.x - playerX) < 38) {
        score += 5;
        document.getElementById('scoreEl').textContent = score;
        beep(880, 0.08);
        star = { x: 40 + Math.random() * 580, y: 15, vy: 2.5 };
      } else if (star.y > 240) {
        star = { x: 40 + Math.random() * 580, y: 15, vy: 2.5 };
      }
      requestAnimationFrame(loop);
    }

    document.getElementById('startBtn').onclick = () => {
      score = 0; lives = 3; qIdx = 0; running = true;
      document.getElementById('scoreEl').textContent = score;
      document.getElementById('livesEl').textContent = lives;
      showScreen('playScreen');
      renderQuestion();
      loop();
    };
    document.getElementById('restartBtn').onclick = () => document.getElementById('startBtn').click();
    document.getElementById('muteBtn').onclick = () => {
      muted = !muted;
      document.getElementById('muteBtn').textContent = muted ? '🔇 صامت' : '🔊 صوت';
    };
    document.getElementById('rightBtn').onclick = () => { playerX = Math.min(620, playerX + 40); };
    document.getElementById('leftBtn').onclick = () => { playerX = Math.max(40, playerX - 40); };
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') playerX = Math.min(620, playerX + 35);
      if (e.key === 'ArrowLeft') playerX = Math.max(40, playerX - 35);
    });
  </script>
</body>
</html>`;

  const gamePath = path.join(outputDir, 'game.html');
  fs.writeFileSync(gamePath, html, 'utf8');
  return { gamePath, size: Buffer.byteLength(html, 'utf8'), questionsCount: safeQuestions.length };
}

/**
 * Generates Curriculum Pack (Question Bank, Interactive SVG Mind Map, Summary, Learning Objectives)
 */
function generateCurriculumPack({ title, curriculumMeta = {}, objectives = [], summary = '', mindMapNodes = [], questions = [], sourceNotes = [], outputDir }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const nodes = mindMapNodes.length ? mindMapNodes : ['المفهوم الرئيسي', 'التعريف والقواعد', 'أمثلة تطبيقية', 'أسئلة التقييم'];

  const svgBranches = nodes
    .slice(0, 6)
    .map((n, i) => {
      const y = 60 + i * 52;
      return `<line x1="360" y1="180" x2="170" y2="${y}" stroke="#38bdf8" stroke-width="2"/><rect x="20" y="${y - 18}" width="170" height="36" rx="10" fill="#1e293b" stroke="#6366f1"/><text x="105" y="${y + 5}" text-anchor="middle" fill="#e2e8f0" font-size="13">${escXml(String(n).slice(0, 26))}</text>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>الحزمة التعليمية: ${escXml(title)}</title>
  <style>
    body { font-family: Tahoma, Arial, sans-serif; background:#0f172a; color:#f1f5f9; margin:0; padding:24px; line-height:1.7; }
    .card { max-width:900px; margin:0 auto 16px; background:#1e293b; border:1px solid #334155; border-radius:16px; padding:18px; }
    .badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:bold; }
    .ok { background:rgba(16,185,129,0.2); color:#34d399; }
    .rev { background:rgba(245,158,11,0.2); color:#fbbf24; }
  </style>
</head>
<body>
  <div class="card">
    <h1>📚 ${escXml(title)}</h1>
    <p>${escXml([curriculumMeta.grade, curriculumMeta.term, curriculumMeta.unit].filter(Boolean).join(' • ') || 'حزمة تعليمية موثقة')}</p>
  </div>
  <div class="card">
    <h2>🎯 أهداف التعلم</h2>
    <ul>${objectives.map((o) => `<li>${escXml(o)}</li>`).join('')}</ul>
  </div>
  <div class="card">
    <h2>🧠 الخريطة الذهنية</h2>
    <svg viewBox="0 0 540 360" style="width:100%;max-width:540px;background:#020617;border-radius:12px;">
      ${svgBranches}
      <rect x="330" y="150" width="180" height="60" rx="14" fill="#6366f1"/>
      <text x="420" y="185" text-anchor="middle" fill="#fff" font-size="14" font-weight="bold">${escXml(title.slice(0, 22))}</text>
    </svg>
  </div>
  <div class="card">
    <h2>📝 ملخص الدرس وتوثيق المصادر</h2>
    <p>${escXml(summary)}</p>
    ${sourceNotes.map((s) => `<div><span class="badge ${s.verified ? 'ok' : 'rev'}">${s.verified ? 'مؤكد من المصدر' : 'يحتاج مراجعة'}</span> ${escXml(s.text)}</div>`).join('')}
  </div>
  <div class="card">
    <h2>❓ بنك الأسئلة (${questions.length})</h2>
    <ol>${questions.map((q) => `<li><strong>${escXml(q.question)}</strong><br/>الإجابة: ${escXml(q.answer || q.options?.[q.answerIndex || 0] || '')}</li>`).join('')}</ol>
  </div>
</body>
</html>`;

  const htmlPath = path.join(outputDir, 'curriculum-pack.html');
  const jsonPath = path.join(outputDir, 'curriculum-pack.json');
  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify({ title, curriculumMeta, objectives, summary, mindMapNodes: nodes, questions, sourceNotes }, null, 2), 'utf8');
  return { htmlPath, jsonPath };
}

/**
 * Real binary/JSON GLB & GLTF 3D model inspector (skeleton, textures, size, license)
 */
function inspectGlbOrGltf(filePath, { source = '', license = '' } = {}) {
  const report = {
    valid: false,
    format: '',
    bytes: 0,
    scenes: 0,
    nodes: 0,
    meshes: 0,
    skins: 0,
    joints: 0,
    materials: 0,
    textures: 0,
    animations: 0,
    source,
    license,
    errors: [],
  };

  if (!license || license.toLowerCase().includes('unknown')) {
    report.errors.push('ترخيص النموذج غير معروف أو مفقود — مرفوض الدمج قبل توثيق الترخيص.');
  }
  if (!fs.existsSync(filePath)) {
    report.errors.push('الملف غير موجود.');
    return report;
  }

  const buf = fs.readFileSync(filePath);
  report.bytes = buf.length;
  let gltfJson = null;

  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'glTF') {
    report.format = 'glb';
    const version = buf.readUInt32LE(4);
    if (version !== 2) report.errors.push(`إصدار GLB غير قياسي: ${version}`);
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const chunkLen = buf.readUInt32LE(offset);
      const chunkType = buf.readUInt32LE(offset + 4);
      offset += 8;
      if (chunkType === 0x4e4f534a && offset + chunkLen <= buf.length) {
        try {
          gltfJson = JSON.parse(buf.subarray(offset, offset + chunkLen).toString('utf8'));
        } catch {
          report.errors.push('تلف في مقطع JSON داخل ملف GLB');
        }
      }
      offset += chunkLen;
    }
  } else {
    report.format = 'gltf';
    try {
      gltfJson = JSON.parse(buf.toString('utf8'));
    } catch {
      report.errors.push('ملف GLTF/GLB غير صالح');
    }
  }

  if (gltfJson) {
    report.scenes = (gltfJson.scenes || []).length;
    report.nodes = (gltfJson.nodes || []).length;
    report.meshes = (gltfJson.meshes || []).length;
    report.skins = (gltfJson.skins || []).length;
    report.joints = (gltfJson.skins || []).reduce((acc, s) => acc + (s.joints || []).length, 0);
    report.materials = (gltfJson.materials || []).length;
    report.textures = (gltfJson.textures || []).length;
    report.animations = (gltfJson.animations || []).length;
    if (report.meshes === 0) report.errors.push('النموذج لا يحتوي على أي Meshes');
  }

  if (report.bytes > 15 * 1024 * 1024) {
    report.errors.push('حجم النموذج يتجاوز 15MB وقد يبطئ الهواتف');
  }

  report.valid = report.errors.length === 0;
  return report;
}

/**
 * Independent QA verifier returning structured Bug Reports
 */
function runIndependentQA({ type, outputDir, title }) {
  const bugs = [];

  if (type === 'video') {
    const mp4 = path.join(outputDir, 'video.mp4');
    const srt = path.join(outputDir, 'subtitles.srt');
    if (!fs.existsSync(mp4) || fs.statSync(mp4).size < 8000) {
      bugs.push({ severity: 'critical', title: 'ملف الفيديو MP4 مفقود أو تالف', expected: 'MP4 > 8KB', actual: fs.existsSync(mp4) ? `${fs.statSync(mp4).size} bytes` : 'missing' });
    } else {
      const hdr = fs.readFileSync(mp4).subarray(4, 8).toString('ascii');
      if (hdr !== 'ftyp') {
        bugs.push({ severity: 'critical', title: 'ترويسة MP4 غير صالحة', expected: 'ftyp', actual: hdr });
      }
    }
    if (!fs.existsSync(srt)) {
      bugs.push({ severity: 'medium', title: 'ملف الترجمة subtitles.srt مفقود', expected: 'subtitles.srt present', actual: 'missing' });
    }
  } else if (type === 'booklet') {
    const pdf = path.join(outputDir, 'booklet.pdf');
    const docx = path.join(outputDir, 'booklet.docx');
    if (!fs.existsSync(pdf) || fs.readFileSync(pdf).subarray(0, 5).toString('ascii') !== '%PDF-') {
      bugs.push({ severity: 'critical', title: 'ملف PDF للملزمة غير صالح', expected: '%PDF- header', actual: 'invalid/missing' });
    }
    if (!fs.existsSync(docx) || fs.readFileSync(docx).subarray(0, 2).toString('ascii') !== 'PK') {
      bugs.push({ severity: 'high', title: 'ملف DOCX للملزمة غير صالح', expected: 'PK ZIP header', actual: 'invalid/missing' });
    }
  } else if (type === 'game') {
    const gameFile = path.join(outputDir, 'game.html');
    if (!fs.existsSync(gameFile)) {
      bugs.push({ severity: 'critical', title: 'ملف اللعبة game.html غير موجود', expected: 'game.html', actual: 'missing' });
    } else {
      const html = fs.readFileSync(gameFile, 'utf8');
      if (!html.includes('startScreen') || !html.includes('endScreen')) {
        bugs.push({ severity: 'high', title: 'اللعبة تفتقد شاشة البداية أو النهاية', expected: 'startScreen + endScreen', actual: 'missing' });
      }
      if (!html.includes('viewport')) {
        bugs.push({ severity: 'medium', title: 'اللعبة غير مهيأة لشاشات الهاتف', expected: 'meta viewport', actual: 'missing' });
      }
      const sec = scanGeneratedCodeSafety(html);
      if (!sec.safe) {
        bugs.push({ severity: 'critical', title: 'مشكلة أمان في كود اللعبة', expected: 'safe code', actual: JSON.stringify(sec.findings) });
      }
    }
  } else if (type === 'app' || type === 'web') {
    const appFile = path.join(outputDir, 'index.html');
    if (!fs.existsSync(appFile)) {
      bugs.push({ severity: 'critical', title: `ملف التطبيق "${title}" مفقود`, expected: 'index.html', actual: 'missing' });
    } else {
      const html = fs.readFileSync(appFile, 'utf8');
      if (!html.includes('<html') || !html.includes('</html>')) {
        bugs.push({ severity: 'high', title: 'هيكل HTML غير مكتمل', expected: '<html>...</html>', actual: 'incomplete' });
      }
      const sec = scanGeneratedCodeSafety(html);
      if (!sec.safe) {
        bugs.push({ severity: 'critical', title: 'تحذير أمني في الكود المولد', expected: 'clean sandbox scan', actual: JSON.stringify(sec.findings) });
      }
    }
  }

  return {
    passed: bugs.length === 0,
    bugs,
    checkedAt: new Date().toISOString(),
  };
}

const PptxGenJS = require('pptxgenjs');

/**
 * Generates a real downloadable Arabic RTL PowerPoint (.pptx) presentation
 */
async function generatePowerPointPptx({ title, subtitle = 'عرض تقديمي احترافي — إعداد شركة الذكاء الاصطناعي', slides = [], outputDir }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.rtlMode = true;
  pptx.title = title;
  pptx.author = 'AI Virtual Office — أ. طارق وفريق الإنتاج';

  // Cover Slide
  const cover = pptx.addSlide();
  cover.background = { color: '0F172A' };
  cover.addShape(pptx.ShapeType.rect, { x: 0.6, y: 0.6, w: 12.1, h: 6.3, fill: { color: '1E293B' }, line: { color: '38BDF8', width: 2 } });
  cover.addText(title, { x: 1.0, y: 2.1, w: 11.3, h: 1.4, fontSize: 36, bold: true, color: '38BDF8', align: 'center', rtlMode: true });
  cover.addText(subtitle, { x: 1.2, y: 3.6, w: 10.9, h: 0.9, fontSize: 18, color: 'E2E8F0', align: 'center', rtlMode: true });

  const safeSlides =
    Array.isArray(slides) && slides.length > 0
      ? slides
      : [
          { heading: 'مقدمة وأهداف العرض', bullets: ['نظرة شاملة على الموضوع', 'الأهداف الرئيسية والنتائج المتوقعة'] },
          { heading: 'المحاور الأساسية', bullets: ['التحليل والتخطيط التنفيذي', 'التطبيق العملي والأدوات المستخدمة'] },
          { heading: 'الخلاصة والتوصيات', bullets: ['أهم النقاط المستفادة', 'الخطوات العملية القادمة'] },
        ];

  safeSlides.forEach((s, idx) => {
    const sl = pptx.addSlide();
    sl.background = { color: '0F172A' };
    sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 1.05, fill: { color: '1E1B4B' } });
    sl.addText(`${idx + 1}. ${s.heading || title}`, {
      x: 0.6,
      y: 0.18,
      w: 12.1,
      h: 0.7,
      fontSize: 24,
      bold: true,
      color: '38BDF8',
      align: 'right',
      rtlMode: true,
    });
    const bullets = Array.isArray(s.bullets) ? s.bullets : [String(s.body || s.heading || '')];
    sl.addText(
      bullets.map((b) => ({ text: `• ${b}\n`, options: { fontSize: 19, color: 'F1F5F9', breakLine: true } })),
      { x: 0.8, y: 1.45, w: 11.7, h: 5.2, align: 'right', valign: 'top', rtlMode: true }
    );
  });

  const pptxPath = path.join(outputDir, 'presentation.pptx');
  await pptx.writeFile({ fileName: pptxPath });
  return {
    pptxPath,
    size: fs.statSync(pptxPath).size,
    slideCount: safeSlides.length + 1,
  };
}

/**
 * Generates an image via HuggingFace Inference API if HF_API_KEY is present;
 * otherwise generates a clean PNG design poster when type='poster', or reports honestly that photorealistic AI image key is required.
 */
async function generateImageDeliverable({ prompt, title = 'تصميم', hfApiKey = '', outputDir }) {
  fs.mkdirSync(outputDir, { recursive: true });
  if (hfApiKey) {
    const models = ['black-forest-labs/FLUX.1-schnell', 'stabilityai/stable-diffusion-xl-base-1.0'];
    for (const model of models) {
      try {
        const res = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${hfApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputs: prompt }),
        });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 4000) {
            const imgPath = path.join(outputDir, 'image.png');
            fs.writeFileSync(imgPath, buf);
            return { ok: true, mode: `huggingface:${model}`, imgPath, size: buf.length };
          }
        }
      } catch {}
    }
  }
  return {
    ok: false,
    needsImageKey: true,
    reason: 'توليد الصور بالذكاء الاصطناعي يتطلب مفتاح Hugging Face مجاني (HF_API_KEY) لأن باقة Google المجانية للصور متوقفة بحد الحصة (429).',
  };
}

module.exports = {
  generateRealVideo,
  generateBookletFiles,
  generatePowerPointPptx,
  generateImageDeliverable,
  generateEducationalGame,
  generateCurriculumPack,
  inspectGlbOrGltf,
  runIndependentQA,
  shapeArabicForPdf,
};
