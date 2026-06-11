/* storage.js — localStorage への成績・間違い履歴の保存 */
(function () {
  'use strict';

  const STATS_KEY = 'lx:stats:v1';
  const WRONG_KEY = 'lx:wrong:v1';
  const THEME_KEY = 'lx:theme';

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

    getTheme() { return localStorage.getItem(THEME_KEY); },
    setTheme(t) { try { localStorage.setItem(THEME_KEY, t); } catch (e) {} },
  };

  window.LXStore = LXStore;
})();
