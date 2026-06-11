/* storage.js — localStorage への成績・間違い履歴の保存 */
(function () {
  'use strict';

  const STATS_KEY = 'lx:stats:v1';
  const WRONG_KEY = 'lx:wrong:v1';
  const THEME_KEY = 'lx:theme';
  const HISTORY_KEY = 'lx:history:v1';   // セッション履歴(分野別内訳つき)
  const QSTATS_KEY = 'lx:qstats:v1';     // 問題ごとの解答統計
  const AI_KEY = 'lx:ai:v1';             // AIアドバイス設定(APIキー等)
  const HISTORY_LIMIT = 50;              // デッキごとに保持するセッション数

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* プライベートモード等では保存できないが動作は継続 */ }
  }

  const LXStore = {
    // deckId(= データファイルのパス)ごとの成績
    getStats(deckId) {
      const all = load(STATS_KEY, {});
      return all[deckId] || { attempts: 0, best: 0, last: null, answered: 0, correct: 0 };
    },

    recordResult(deckId, correctCount, total) {
      const all = load(STATS_KEY, {});
      const s = all[deckId] || { attempts: 0, best: 0, last: null, answered: 0, correct: 0 };
      const score = total > 0 ? Math.round((correctCount / total) * 100) : 0;
      s.attempts += 1;
      s.best = Math.max(s.best, score);
      s.last = score;
      s.answered += total;
      s.correct += correctCount;
      all[deckId] = s;
      save(STATS_KEY, all);
    },

    // 間違えた問題 id の集合
    getWrongIds(deckId) {
      const all = load(WRONG_KEY, {});
      return new Set(all[deckId] || []);
    },

    updateWrong(deckId, wrongIds, correctIds) {
      const all = load(WRONG_KEY, {});
      const set = new Set(all[deckId] || []);
      correctIds.forEach(id => set.delete(id)); // 正解できたら復習リストから外す
      wrongIds.forEach(id => set.add(id));
      all[deckId] = Array.from(set);
      save(WRONG_KEY, all);
    },

    // セッション履歴: {at, mode, category, total, correct, score, elapsedSec,
    //                  cats: {分野名: [正解数, 出題数]}, types: {形式: [正解数, 出題数]}}
    getHistory(deckId) {
      const all = load(HISTORY_KEY, {});
      return all[deckId] || [];
    },

    recordSession(deckId, session) {
      const all = load(HISTORY_KEY, {});
      const list = all[deckId] || [];
      list.push(session);
      if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
      all[deckId] = list;
      save(HISTORY_KEY, all);
    },

    // 問題ごとの統計: {a: 解答回数, c: 正解回数, s: 連続正解数, t: 最終解答時刻}
    getQuestionStats(deckId) {
      const all = load(QSTATS_KEY, {});
      return all[deckId] || {};
    },

    recordQuestionResults(deckId, results) {
      const all = load(QSTATS_KEY, {});
      const stats = all[deckId] || {};
      const now = Date.now();
      results.forEach(({ id, correct }) => {
        const q = stats[id] || { a: 0, c: 0, s: 0, t: 0 };
        q.a += 1;
        if (correct) { q.c += 1; q.s += 1; } else { q.s = 0; }
        q.t = now;
        stats[id] = q;
      });
      all[deckId] = stats;
      save(QSTATS_KEY, all);
    },

    // AIアドバイス設定 {apiKey, model}
    getAiSettings() { return load(AI_KEY, {}); },
    setAiSettings(settings) { save(AI_KEY, settings); },

    getTheme() { return localStorage.getItem(THEME_KEY); },
    setTheme(t) { try { localStorage.setItem(THEME_KEY, t); } catch (e) {} },
  };

  window.LXStore = LXStore;
})();
