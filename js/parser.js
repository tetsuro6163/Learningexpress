/* parser.js — Markdown を問題データに変換する
 *
 * 2種類の書き方に対応する。
 *
 * ■ かんたん形式(自動判定)
 *   ## 問題文
 *   - [x] 正解 / - [ ] 不正解          → 選択問題([x]複数で複数選択)
 *   1. 項目 / 2. 項目                  → 並び替え(書いた順が正解)
 *   答え: ○ / 答え: ×                  → 正誤(○×)問題
 *   > 解説                             → 解説
 *
 * ■ 教材形式(一問一答・単語リスト・穴埋め)
 *   ## 章タイトル / ### 節タイトル       → 章・節(出題のカテゴリになる)
 *   **Q1.** 文              **A.** ○ (条文)   → 正誤(○×)問題 + 解説
 *   **Q.** …( ① )…         **A.** ① 答え      → 穴埋め(めくって自己採点)
 *   | 用語 | 定義 | のテーブル                  → 単語カード(めくって自己採点)
 */

(function () {
  'use strict';

  const TF_TRUE = ['○', '◯', '〇', 'o', 'O', '正', 'true', 'はい'];
  const TF_FALSE = ['×', '✕', '✖', '✗', 'x', 'X', '誤', 'false', 'いいえ'];
  const MARU = ['○', '◯', '〇'];
  const BATSU = ['×', '✕', '✖', '✗'];

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function inlineMd(s) {
    let out = escapeHtml(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return out;
  }

  function mdToHtml(text) {
    if (!text) return '';
    const lines = text.split('\n');
    const parts = [];
    let para = [];
    let inCode = false;
    let codeLines = [];

    function flushPara() {
      if (para.length) {
        parts.push('<p>' + para.map(inlineMd).join('<br>') + '</p>');
        para = [];
      }
    }

    for (const line of lines) {
      if (/^```/.test(line.trim())) {
        if (inCode) {
          parts.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
          codeLines = [];
          inCode = false;
        } else { flushPara(); inCode = true; }
        continue;
      }
      if (inCode) { codeLines.push(line); continue; }
      if (line.trim() === '') { flushPara(); continue; }
      para.push(line);
    }
    if (inCode) parts.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
    flushPara();
    return parts.join('\n');
  }

  function hashId(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return 'q' + (h >>> 0).toString(36);
  }

  function parseTfAnswer(value) {
    const v = value.trim();
    if (TF_TRUE.includes(v) || TF_TRUE.includes(v.toLowerCase())) return true;
    if (TF_FALSE.includes(v) || TF_FALSE.includes(v.toLowerCase())) return false;
    return null;
  }

  // ---------- かんたん形式: ## ブロック1つ = 問題1つ ----------

  function isSimpleFormatBlock(lines) {
    let inCode = false;
    for (const line of lines) {
      if (/^```/.test(line.trim())) { inCode = !inCode; continue; }
      if (inCode) continue;
      if (/^\s*[-*]\s*\[( |x|X)\]\s+/.test(line)) return true;   // チェックリスト
      if (/^\s*\d+[.)]\s+/.test(line)) return true;              // 番号付きリスト
      if (/^\s*(?:答え|解答|answer)\s*[:：]/i.test(line)) return true;
    }
    return false;
  }

  function parseSimpleBlock(headingText, bodyLines, warnings) {
    const choices = [];
    const orderItems = [];
    const explanation = [];
    const body = [];
    let tfAnswer = null;
    let inCode = false;

    for (const line of bodyLines) {
      if (/^```/.test(line.trim())) inCode = !inCode;
      if (inCode || /^```/.test(line.trim())) { body.push(line); continue; }

      let m;
      if ((m = line.match(/^\s*[-*]\s*\[( |x|X)\]\s+(.*)$/))) {
        choices.push({ text: m[2].trim(), correct: m[1].toLowerCase() === 'x' });
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        orderItems.push(m[1].trim());
      } else if ((m = line.match(/^\s*(?:答え|解答|answer)\s*[:：]\s*(.*)$/i))) {
        tfAnswer = parseTfAnswer(m[1]);
        if (tfAnswer === null) warnings.push(`「${headingText}」: 答えの値「${m[1].trim()}」を ○/× として解釈できません`);
      } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
        explanation.push(m[1]);
      } else {
        body.push(line);
      }
    }

    const base = {
      id: hashId(headingText + ' ' + bodyLines.join('\n').slice(0, 200)),
      prompt: headingText,
      promptHtml: inlineMd(headingText),
      bodyHtml: mdToHtml(body.join('\n').trim()),
      explanationHtml: mdToHtml(explanation.join('\n').trim()),
      category: '',
    };

    if (choices.length >= 2) {
      const correctCount = choices.filter(c => c.correct).length;
      if (correctCount === 0) { warnings.push(`「${headingText}」: 正解の選択肢([x])がありません`); return null; }
      return Object.assign(base, {
        type: correctCount > 1 ? 'multi' : 'choice',
        choices: choices.map(c => ({ html: inlineMd(c.text), correct: c.correct })),
      });
    }
    if (orderItems.length >= 2) {
      return Object.assign(base, { type: 'order', items: orderItems.map(t => inlineMd(t)) });
    }
    if (tfAnswer !== null) {
      return Object.assign(base, { type: 'tf', answer: tfAnswer });
    }
    warnings.push(`「${headingText}」: 問題形式を判別できないためスキップしました`);
    return null;
  }

  // ---------- 教材形式: 章/節の中から Q&A・テーブルを抽出 ----------

  function makeQA(promptLines, answerLines, category, questions) {
    const prompt = promptLines.join('\n').trim();
    const answer = answerLines.join('\n').trim();
    if (!prompt || !answer) return;
    const first = answer.charAt(0);
    const idBase = hashId(category + '|' + prompt + '|' + answer.slice(0, 60));

    if (MARU.includes(first) || BATSU.includes(first)) {
      const isTrue = MARU.includes(first);
      const rest = answer.slice(1).trim();
      questions.push({
        id: idBase, type: 'tf', answer: isTrue, category,
        prompt, promptHtml: inlineMd(prompt), bodyHtml: '',
        explanationHtml: rest ? mdToHtml(rest) : '',
      });
    } else {
      // 穴埋め・記述 → めくって自己採点するフラッシュカード
      questions.push({
        id: idBase, type: 'flash', category,
        prompt, promptHtml: inlineMd(prompt), bodyHtml: '',
        frontHtml: mdToHtml(prompt),
        backHtml: mdToHtml(answer),
        explanationHtml: '',
      });
    }
  }

  function isTableLine(line) {
    const t = line.trim();
    return t.startsWith('|') && t.indexOf('|', 1) !== -1;
  }
  function tableCells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  }
  function isSeparatorRow(cells) {
    return cells.length > 0 && cells.every(c => /^:?-{1,}:?$/.test(c.replace(/\s/g, '')));
  }

  // 用語リスト形式のテーブルか(ヘッダーが「用語／定義」系か)を判定する。
  // 先例・判例など1列目が長文のテーブルを用語集から除外するために使う。
  const TERM_HEAD = /用語|語句|言葉|単語|term/i;
  const DEF_HEAD = /定義|意味|説明|内容|definition|meaning/i;
  function isGlossaryHeader(headerCells) {
    if (!headerCells || headerCells.length < 2) return false;
    return TERM_HEAD.test(headerCells[0]) || DEF_HEAD.test(headerCells[1]);
  }

  function processTable(rows, category, questions, warnings, glossary) {
    if (rows.length < 2) return;
    const parsed = rows.map(tableCells);
    let start = 0;
    if (isSeparatorRow(parsed[1])) start = 2;       // header + separator を飛ばす
    else if (isSeparatorRow(parsed[0])) start = 1;
    // 用語集への登録はヘッダー付きの用語リストテーブルに限る
    const toGlossary = glossary && start === 2 && isGlossaryHeader(parsed[0]);
    for (let i = start; i < parsed.length; i++) {
      const cells = parsed[i];
      if (isSeparatorRow(cells)) continue;
      if (cells.length < 2 || !cells[0]) continue;
      const front = cells[0];
      const back = cells.slice(1).filter(Boolean).join('\n\n');
      if (!back) continue;
      if (toGlossary) glossary[front] = mdToHtml(back);
      questions.push({
        id: hashId(category + '|tbl|' + front + '|' + back.slice(0, 40)),
        type: 'flash', category,
        prompt: front, promptHtml: inlineMd(front), bodyHtml: '',
        frontHtml: '<p class="flash-term">' + inlineMd(front) + '</p>',
        backHtml: mdToHtml(back),
        explanationHtml: '',
      });
    }
  }

  function extractSection(category, lines, questions, warnings, glossary) {
    let i = 0;
    let inCode = false;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line.trim())) { inCode = !inCode; i++; continue; }
      if (inCode) { i++; continue; }

      // Q&A ペア
      const qm = line.match(/^\s*\*\*\s*Q[^*]*\*\*\s*(.*)$/i);
      if (qm) {
        const promptLines = [];
        if (qm[1].trim()) promptLines.push(qm[1].trim());
        i++;
        while (i < lines.length && !/^\s*\*\*\s*A[^*]*\*\*/i.test(lines[i])) {
          if (lines[i].trim()) promptLines.push(lines[i].trim());
          i++;
        }
        if (i < lines.length) {
          const am = lines[i].match(/^\s*\*\*\s*A[^*]*\*\*\s*(.*)$/i);
          const answerLines = [];
          if (am && am[1].trim()) answerLines.push(am[1].trim());
          i++;
          while (i < lines.length && lines[i].trim() !== '' &&
                 !/^\s*\*\*\s*Q[^*]*\*\*/i.test(lines[i]) &&
                 !isTableLine(lines[i]) && !/^#{1,6}\s/.test(lines[i])) {
            answerLines.push(lines[i].trim());
            i++;
          }
          makeQA(promptLines, answerLines, category, questions);
        } else {
          warnings.push(`「${category}」: 「${promptLines.join(' ').slice(0, 20)}…」に対応する **A.** が見つかりません`);
        }
        continue;
      }

      // テーブル
      if (isTableLine(line)) {
        const rows = [];
        while (i < lines.length && isTableLine(lines[i])) { rows.push(lines[i]); i++; }
        processTable(rows, category, questions, warnings, glossary);
        continue;
      }

      i++;
    }
  }

  // ---------- デッキ全体 ----------

  function parseDeck(mdText) {
    const lines = mdText.replace(/\r\n/g, '\n').split('\n');
    const warnings = [];
    let title = '';
    const descParts = [];
    const blocks = []; // {heading, lines}
    let current = null;
    let inCode = false;

    for (const line of lines) {
      if (/^```/.test(line.trim())) inCode = !inCode;
      if (!inCode) {
        const h1 = line.match(/^#\s+(.*)$/);
        const h2 = line.match(/^##\s+(.*)$/);
        if (h1 && !title && !current) { title = h1[1].trim(); continue; }
        if (h2) { current = { heading: h2[1].trim(), lines: [] }; blocks.push(current); continue; }
      }
      if (current) current.lines.push(line);
    }

    const questions = [];
    const glossary = {};
    let sawQuestion = false;

    for (const block of blocks) {
      if (isSimpleFormatBlock(block.lines)) {
        const q = parseSimpleBlock(block.heading, block.lines, warnings);
        if (q) { questions.push(q); sawQuestion = true; }
        continue;
      }
      const before = questions.length;
      extractSection(block.heading, block.lines, questions, warnings, glossary);
      if (questions.length === before && !sawQuestion) {
        // 最初の見出し+注記 → デッキの説明として扱う
        descParts.push('**' + block.heading + '**');
        block.lines.forEach(l => {
          const q = l.match(/^\s*>\s?(.*)$/);
          if (q && q[1].trim()) descParts.push(q[1].trim());
        });
      } else if (questions.length > before) {
        sawQuestion = true;
      }
    }

    return {
      title: title || '無題のデッキ',
      descriptionHtml: mdToHtml(descParts.join('\n\n')),
      questions,
      warnings,
      glossary,
    };
  }

  window.LXParser = { parseDeck, mdToHtml, inlineMd };
})();
