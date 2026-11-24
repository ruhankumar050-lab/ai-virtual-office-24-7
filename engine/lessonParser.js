const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

async function parseLessonBuffer(buffer, fileName = 'lesson.txt') {
  const ext = path.extname(fileName).toLowerCase();
  let text = '';

  if (ext === '.pdf') {
    const data = await pdfParse(buffer);
    text = data.text || '';
  } else if (ext === '.docx') {
    const res = await mammoth.extractRawText({ buffer });
    text = res.value || '';
  } else if (ext === '.pptx') {
    // Extract text runs from pptx slides XML via python3 zipfile
    const tmp = `/tmp/lesson-${Date.now()}.pptx`;
    fs.writeFileSync(tmp, buffer);
    try {
      text = execFileSync('python3', [
        '-c',
        `import zipfile, xml.etree.ElementTree as ET, sys
out = []
with zipfile.ZipFile(sys.argv[1]) as z:
    slides = sorted([n for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml')])
    for s in slides:
        root = ET.fromstring(z.read(s))
        texts = [el.text for el in root.iter() if el.tag.endswith('}t') and el.text]
        if texts:
            out.append(' '.join(texts))
print('\\n'.join(out))`,
        tmp,
      ]).toString('utf8');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  } else {
    text = buffer.toString('utf8');
  }

  return {
    fileName,
    ext,
    text: text.replace(/\r/g, '').trim(),
    charCount: text.trim().length,
  };
}

module.exports = { parseLessonBuffer };
