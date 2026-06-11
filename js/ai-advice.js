/* ai-advice.js — 学習データの集計と LLM(Claude API)によるアドバイス生成 */
(function () {
  'use strict';

  const API_URL = 'https://api.anthropic.com/v1/messages';
  const DEFAULT_MODEL = 'claude-opus-4-8';
  const MODELS = [
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8(高品質・推奨)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6(バランス)' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5(高速・低コスト)' },
  ];

  // ---------- 学習データの集計 ----------

  function stripHtml(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function truncate(text, len) {
    return text.length > len ? text.slice(0, len) + '…' : text;
  }

  function pct(correct, total) {
    return total > 0 ? Math.round((correct / total) * 100) : 0;
  }

  const TYPE_LABEL = {
    choice: '四択・選択', multi: '複数選択', order: '並び替え',
    tf: '正誤(○×)', flash: 'カード(自己採点)',
  };

  // decks: [{file, deck}] — 学習済みデッキの実績をテキストにまとめる
  function buildSummary(decks) {
    const lines = [];
    let hasData = false;

    for (const { file, deck } of decks) {
      const stats = LXStore.getStats(file);
      if (stats.attempts === 0) continue;
      hasData = true;

      const history = LXStore.getHistory(file);
      const qstats = LXStore.getQuestionStats(file);
      const wrongIds = LXStore.getWrongIds(file);

      lines.push(`■ デッキ「${stripHtml(LXParser.inlineMd(deck.title))}」(全${deck.questions.length}問)`);
      lines.push(`- 挑戦${stats.attempts}回 / 通算正答率 ${pct(stats.correct, stats.answered)}% (${stats.correct}/${stats.answered}) / 自己ベスト ${stats.best}% / 前回 ${stats.last}%`);

      const recent = history.slice(-5);
      if (recent.length > 0) {
        const trend = recent.map(h => {
          const d = new Date(h.at);
          const scope = h.category ? `「${h.category}」` : (h.mode === 'review' ? '復習' : '全範囲');
          return `${d.getMonth() + 1}/${d.getDate()} ${scope} ${h.score}%`;
        }).join(' → ');
        lines.push(`- 直近のセッション: ${trend}`);
      }

      // 分野別の通算正答率(問題ごとの統計から集計)
      const catAgg = {};   // {cat: [正解, 解答]}
      const typeAgg = {};  // {type: [正解, 解答]}
      for (const q of deck.questions) {
        const st = qstats[q.id];
        if (!st) continue;
        const cat = q.category || '(分野なし)';
        (catAgg[cat] = catAgg[cat] || [0, 0])[0] += st.c;
        catAgg[cat][1] += st.a;
        (typeAgg[q.type] = typeAgg[q.type] || [0, 0])[0] += st.c;
        typeAgg[q.type][1] += st.a;
      }
      const cats = Object.entries(catAgg).filter(([, v]) => v[1] > 0)
        .sort((a, b) => pct(a[1][0], a[1][1]) - pct(b[1][0], b[1][1]));
      if (cats.length > 1) {
        lines.push('- 分野別正答率(低い順):');
        cats.forEach(([c, [ok, all]]) => lines.push(`  - ${c}: ${pct(ok, all)}% (${ok}/${all})`));
      }
      const types = Object.entries(typeAgg).filter(([, v]) => v[1] > 0);
      if (types.length > 1) {
        lines.push('- 形式別正答率: ' + types.map(([t, [ok, all]]) =>
          `${TYPE_LABEL[t] || t} ${pct(ok, all)}% (${ok}/${all})`).join('、'));
      }

      // 繰り返し間違えている問題(2回以上解いて正答率50%未満)
      const struggling = deck.questions
        .map(q => ({ q, st: qstats[q.id] }))
        .filter(({ st }) => st && st.a >= 2 && st.c / st.a < 0.5)
        .sort((a, b) => (a.st.c / a.st.a) - (b.st.c / b.st.a))
        .slice(0, 12);
      if (struggling.length > 0) {
        lines.push('- 繰り返し間違えている問題:');
        struggling.forEach(({ q, st }) => {
          const cat = q.category ? `[${q.category}] ` : '';
          lines.push(`  - ${cat}「${truncate(stripHtml(q.promptHtml), 60)}」(${st.a}回中${st.c}回正解)`);
        });
      }

      const wrongCount = deck.questions.filter(q => wrongIds.has(q.id)).length;
      if (wrongCount > 0) lines.push(`- 現在の復習リスト: ${wrongCount}問`);
      lines.push('');
    }

    return hasData ? lines.join('\n').trim() : null;
  }

  function buildPrompt(summary) {
    return [
      'あなたは資格試験・学習指導の経験豊富なコーチです。',
      '以下はクイズ学習アプリに記録された、私の学習データです。',
      '',
      '---',
      summary,
      '---',
      '',
      'このデータをもとに、日本語で次の4点をアドバイスしてください:',
      '1. **総評** — 現在の習熟度と伸びている点',
      '2. **弱点と間違いの傾向** — どの分野・形式でつまずいているか、なぜ間違えやすいかの仮説',
      '3. **おすすめの学習順序** — どの分野・どの問題から優先的に取り組むべきか',
      '4. **次の学習プラン** — 今後1週間の具体的な進め方(1日あたりの目安も)',
      '',
      '出力はMarkdownで、見出しと箇条書きを使って簡潔に。励ましの一言も添えてください。',
    ].join('\n');
  }

  // ---------- Claude API 呼び出し(ブラウザ直接・ユーザー自身のAPIキー) ----------

  async function requestAdvice(prompt) {
    const settings = LXStore.getAiSettings();
    if (!settings.apiKey) {
      throw new Error('APIキーが未設定です。右上の ⚙️ から設定してください。');
    }

    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
          // ブラウザから直接呼び出すためのCORSオプトイン(キーは利用者自身のもの)
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: settings.model || DEFAULT_MODEL,
          max_tokens: 8000,
          thinking: { type: 'adaptive' },
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (e) {
      throw new Error('通信に失敗しました。ネットワーク接続を確認してください。');
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error.message; } catch (e) { /* ignore */ }
      const msg = {
        401: 'APIキーが無効です。⚙️ 設定を確認してください。',
        403: 'このAPIキーには権限がありません。',
        429: 'レート制限中です。しばらく待ってから再試行してください。',
        529: 'APIが混雑しています。しばらく待ってから再試行してください。',
      }[res.status];
      throw new Error(msg || `APIエラー (${res.status})${detail ? ': ' + detail : ''}`);
    }

    const data = await res.json();
    if (data.stop_reason === 'refusal') {
      throw new Error('AIがこのリクエストへの回答を控えました。');
    }
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    if (!text) throw new Error('AIから有効な応答が得られませんでした。');
    return text;
  }

  // ---------- アドバイス(Markdown)の安全なHTML化 ----------

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inline(s) {
    return escapeHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  function mdToHtml(md) {
    const out = [];
    let listType = null; // 'ul' | 'ol' | null
    const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

    for (const raw of md.split('\n')) {
      const line = raw.trimEnd();
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (h) {
        closeList();
        const level = Math.min(h[1].length + 2, 5); // # → h3 に格下げ(カード内見出し)
        out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      } else if (ul) {
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push(`<li>${inline(ul[1])}</li>`);
      } else if (ol) {
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push(`<li>${inline(ol[1])}</li>`);
      } else if (line.trim() === '') {
        closeList();
      } else {
        closeList();
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    closeList();
    return out.join('\n');
  }

  // ---------- アドバイスパネルのUI ----------

  // container にアドバイスUIを描画。decks は [{file, deck}]
  function renderPanel(container, decks) {
    const summary = buildSummary(decks);
    container.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'card advice-card';

    if (!summary) {
      card.innerHTML = `
        <h3>🤖 AI学習アドバイス</h3>
        <p class="muted">クイズに挑戦すると、正解状況や間違いの傾向をもとにAIが学習アドバイスを生成できます。</p>`;
      container.appendChild(card);
      return;
    }

    const hasKey = !!LXStore.getAiSettings().apiKey;
    card.innerHTML = `
      <h3>🤖 AI学習アドバイス</h3>
      <p class="muted advice-lead">これまでの正解状況・間違いの傾向・分野別の成績をもとに、弱点分析と学習順序のアドバイスを生成します。</p>
      <div class="advice-actions">
        <button class="btn btn-primary" id="btn-advice-generate">✨ アドバイスを生成</button>
        <button class="btn" id="btn-advice-copy" title="APIキーなしでも、プロンプトをコピーして ChatGPT や Claude に貼り付ければ同じアドバイスが得られます">📋 プロンプトをコピー</button>
      </div>
      ${hasKey ? '' : '<p class="advice-hint muted">「生成」には Anthropic APIキーが必要です(右上の ⚙️ から設定)。キーがなくても「プロンプトをコピー」して ChatGPT / Claude に貼り付ければ利用できます。</p>'}
      <div class="advice-output" id="advice-output" hidden></div>`;
    container.appendChild(card);

    const output = card.querySelector('#advice-output');
    const genBtn = card.querySelector('#btn-advice-generate');
    const copyBtn = card.querySelector('#btn-advice-copy');

    genBtn.addEventListener('click', async () => {
      output.hidden = false;
      output.innerHTML = '<p class="muted advice-loading">⏳ 学習データを分析中… (10〜60秒ほどかかります)</p>';
      genBtn.disabled = true;
      try {
        const advice = await requestAdvice(buildPrompt(buildSummary(decks)));
        output.innerHTML = `<div class="advice-md">${mdToHtml(advice)}</div>`;
      } catch (e) {
        output.innerHTML = `<p class="advice-error">⚠️ ${escapeHtml(e.message)}</p>`;
      } finally {
        genBtn.disabled = false;
      }
    });

    copyBtn.addEventListener('click', async () => {
      const prompt = buildPrompt(buildSummary(decks));
      try {
        await navigator.clipboard.writeText(prompt);
        copyBtn.textContent = '✅ コピーしました';
      } catch (e) {
        // クリップボードAPIが使えない場合はテキストエリアで表示
        output.hidden = false;
        output.innerHTML = `<p class="muted">以下を選択してコピーし、ChatGPT や Claude に貼り付けてください:</p>
          <textarea class="advice-prompt-text" readonly rows="10"></textarea>`;
        output.querySelector('textarea').value = prompt;
      }
      setTimeout(() => { copyBtn.textContent = '📋 プロンプトをコピー'; }, 2000);
    });
  }

  // ---------- 設定モーダル ----------

  function openSettings() {
    const existing = document.getElementById('ai-settings-overlay');
    if (existing) existing.remove();

    const settings = LXStore.getAiSettings();
    const overlay = document.createElement('div');
    overlay.id = 'ai-settings-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="card modal-card" role="dialog" aria-label="AIアドバイス設定">
        <h3>⚙️ AIアドバイス設定</h3>
        <label class="settings-label">Anthropic APIキー
          <input type="password" id="ai-api-key" class="settings-input" placeholder="sk-ant-..." autocomplete="off">
        </label>
        <label class="settings-label">モデル
          <select id="ai-model" class="settings-input">
            ${MODELS.map(m => `<option value="${m.id}">${m.label}</option>`).join('')}
          </select>
        </label>
        <p class="muted settings-note">キーはこのブラウザの localStorage にのみ保存され、Anthropic API 以外には送信されません。共用PCでは保存しないでください。
        キーは <a href="https://platform.claude.com/" target="_blank" rel="noopener">Claude Platform</a> で発行できます(API利用は従量課金)。</p>
        <div class="modal-actions">
          <button class="btn" id="ai-settings-clear">キーを削除</button>
          <span class="modal-spacer"></span>
          <button class="btn" id="ai-settings-cancel">キャンセル</button>
          <button class="btn btn-primary" id="ai-settings-save">保存</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const keyInput = overlay.querySelector('#ai-api-key');
    const modelSelect = overlay.querySelector('#ai-model');
    keyInput.value = settings.apiKey || '';
    modelSelect.value = settings.model || DEFAULT_MODEL;

    const close = () => overlay.remove();
    overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
    overlay.querySelector('#ai-settings-cancel').addEventListener('click', close);
    overlay.querySelector('#ai-settings-clear').addEventListener('click', () => {
      LXStore.setAiSettings({});
      close();
    });
    overlay.querySelector('#ai-settings-save').addEventListener('click', () => {
      LXStore.setAiSettings({ apiKey: keyInput.value.trim(), model: modelSelect.value });
      close();
    });
    keyInput.focus();
  }

  window.LXAdvice = { renderPanel, openSettings, buildSummary };
})();
