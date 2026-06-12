/* trainer.js — 学習状況に適応する出題エンジン */
(function () {
  'use strict';

  const DAY = 86400000;
  // 連続正解数 → 次に復習するまでの間隔(日)。それ以上は14日
  const SRS_INTERVALS = { 1: 1, 2: 3, 3: 7 };
  const FOCUS_TTL = 14 * DAY; // AI出題プランの有効期間

  const REASON_LABEL = {
    review: '🔁 前回間違えた問題',
    weak: '📉 苦手な問題',
    due: '⏰ 復習どき',
    unseen: '🆕 はじめての問題',
    check: '✅ 定着チェック',
  };

  function srsInterval(streak) {
    return (SRS_INTERVALS[streak] || 14) * DAY;
  }

  // 1問を分類して基本スコアを付ける(高いほど優先して出題)
  function classify(q, st, wrongIds, now) {
    if (!st || st.a === 0) return { reason: 'unseen', score: 55 };
    const acc = st.c / st.a;
    if (wrongIds.has(q.id)) return { reason: 'review', score: 90 + (1 - acc) * 10 };
    if (acc < 0.5) return { reason: 'weak', score: 85 };
    if (st.s >= 1 && now - st.t >= srsInterval(st.s)) return { reason: 'due', score: 65 };
    return { reason: 'check', score: 10 + (1 - acc) * 15 };
  }

  // 有効なAI出題プランを {分野名: weight(1-3)} の形で返す(なければ null)
  function activeFocus() {
    const plan = LXStore.getFocusPlan();
    if (!plan || !Array.isArray(plan.categories) || Date.now() - plan.at > FOCUS_TTL) return null;
    const map = {};
    plan.categories.forEach(c => {
      if (c && c.name) map[c.name] = Math.min(Math.max(c.weight || 1, 1), 3);
    });
    return Object.keys(map).length > 0 ? map : null;
  }

  // 分野名のゆるい一致(完全一致 → 部分一致)で重みを引く
  function focusWeightFor(category, focus) {
    if (!focus || !category) return 0;
    if (focus[category] != null) return focus[category];
    for (const name of Object.keys(focus)) {
      if (category.includes(name) || name.includes(category)) return focus[name];
    }
    return 0;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // deckEntry: {file, deck} → 優先度の高い limit 件を [{q, reason, focused}] で返す(出題順はシャッフル済み)
  function select(deckEntry, opts) {
    opts = opts || {};
    const limit = opts.limit || 20;
    const now = Date.now();
    const qstats = LXStore.getQuestionStats(deckEntry.file);
    const wrongIds = LXStore.getWrongIds(deckEntry.file);
    const focus = activeFocus();

    let pool = deckEntry.deck.questions;
    if (opts.category) pool = pool.filter(q => q.category === opts.category);

    const scored = pool.map(q => {
      const { reason, score } = classify(q, qstats[q.id], wrongIds, now);
      const w = focusWeightFor(q.category, focus);
      return {
        q, reason,
        focused: w > 0,
        score: score + w * 6 + Math.random() * 8, // ジッターで毎回同じ編成にならないように
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return shuffle(scored.slice(0, limit)).map(({ q, reason, focused }) => ({ q, reason, focused }));
  }

  window.LXTrainer = { select, REASON_LABEL };
})();
