import { getDb, json, dbGetJson, dbPutJson, verifyUser } from "./_db.js";

function defaultGameState(id) {
  return {
    id,
    spores: 0,
    totalSpores: 0,
    breadIndex: 0,
    upgrades: { spray: 0, closet: 0, bag: 0, lab: 0, planet: 0 },
    characters: [],
    equipped: [],
    prestige: 0,
    updatedAt: Date.now()
  };
}

export default async function handler(req) {
  const db = getDb();
  const url = new URL(req.url);
  const action = (url.searchParams.get("action") || "").trim();

  if (req.method === "GET") {
    const me = (url.searchParams.get("me") || "").trim();
    const password = (url.searchParams.get("password") || "").trim();
    const scope = (url.searchParams.get("scope") || "all").trim(); // "state" | "rank" | "trade" | "all"

    const auth = await verifyUser(db, me, password);
    if (!auth) return json({ error: "認証に失敗しました。" }, 403);

    if (action === "state") {
      let state = await dbGetJson(db, "game:" + me);
      if (!state) {
        state = defaultGameState(me);
        await dbPutJson(db, "game:" + me, state);
      }

      let ranking;
      if (scope === "all" || scope === "rank") {
        const { blobs } = await db.list({ prefix: "game:" });
        const allGames = await Promise.all((blobs || []).map(b => dbGetJson(db, b.key)));
        ranking = [];
        for (const g of allGames) {
          if (g && g.id) {
            const leadUid = (g.equipped || [])[0];
            const leadChar = (g.characters || []).find(c => c.uid === leadUid);
            ranking.push({
              id: g.id,
              totalSpores: Number(g.totalSpores || 0),
              breadIndex: Number(g.breadIndex || 0),
              prestige: Number(g.prestige || 0),
              leadCharId: leadChar ? leadChar.charId : null
            });
          }
        }
        ranking.sort((a, b) => b.totalSpores - a.totalSpores);
        ranking = ranking.slice(0, 30);
      }

      let incomingTrades;
      let outgoingTrades;
      if (scope === "all" || scope === "trade") {
        const { blobs: tradeBlobs } = await db.list({ prefix: "trade:" });
        const allTrades = await Promise.all((tradeBlobs || []).map(b => dbGetJson(db, b.key)));
        incomingTrades = [];
        outgoingTrades = [];
        for (const tr of allTrades) {
          if (!tr || tr.status !== "open") continue;
          if (tr.to === me) incomingTrades.push(tr);
          if (tr.from === me) outgoingTrades.push(tr);
        }
      }

      return json({
        ok: true,
        state,
        ...(ranking !== undefined ? { ranking } : {}),
        ...(incomingTrades !== undefined ? { incomingTrades, outgoingTrades } : {})
      });
    }

    return json({ error: "Invalid action" }, 400);
  }

  if (req.method === "POST") {
    let body = {};
    try {
      body = await req.json();
    } catch {
      return json({ error: "不正なリクエストです。" }, 400);
    }

    const me = String(body.me || "").trim();
    const password = String(body.password || "").trim();
    const auth = await verifyUser(db, me, password);
    if (!auth) return json({ error: "認証に失敗しました。" }, 403);

    if (action === "save") {
      const incoming = body.state || {};
      const current = (await dbGetJson(db, "game:" + me)) || defaultGameState(me);

      const clientChars = Array.isArray(incoming.characters) ? incoming.characters : [];
      // サーバー側の既存キャラを基準に追加分だけを取り込み、明示的な合成・廃棄で
      // 消費したUIDは tombstone に記録する。古い端末の自動セーブで復活させない。
      const removedUids = new Set(Array.isArray(current.removedCharacterUids) ? current.removedCharacterUids : []);
      const mergedMap = new Map();
      for (const c of (Array.isArray(current.characters) ? current.characters : [])) {
        if (c && c.uid && c.charId && !removedUids.has(String(c.uid))) mergedMap.set(String(c.uid), c);
      }
      for (const c of clientChars) {
        if (!c || !c.uid || !c.charId) continue;
        const uid = String(c.uid);
        if (removedUids.has(uid) || mergedMap.has(uid)) continue;
        if (mergedMap.size >= 1000) break;
        mergedMap.set(uid, { uid, charId: String(c.charId), obtainedAt: Number(c.obtainedAt) || Date.now() });
      }
      const mergedChars = Array.from(mergedMap.values()).slice(0, 1000);
      const validUids = new Set(mergedChars.map(c => c.uid));
      const mergedEquipped = (Array.isArray(incoming.equipped) ? incoming.equipped : [])
        .filter(uid => validUids.has(uid))
        .slice(0, 3);

      const updated = {
        id: me,
        spores: Math.max(0, Number(incoming.spores || 0)),
        totalSpores: Math.max(Number(current.totalSpores || 0), Number(incoming.totalSpores || 0)),
        breadIndex: Math.max(0, Number(incoming.breadIndex || 0)),
        upgrades: incoming.upgrades || current.upgrades,
        characters: mergedChars,
        removedCharacterUids: Array.from(removedUids).slice(-5000),
        equipped: mergedEquipped,
        prestige: Math.max(0, Number(incoming.prestige || 0)),
        updatedAt: Date.now()
      };
      await dbPutJson(db, "game:" + me, updated);
      // Only return full character list if client character count differs (saves bandwidth on routine auto-saves)
      const charsChanged = mergedChars.length !== clientChars.length || mergedChars.some((c, i) => clientChars[i]?.uid !== c.uid);
      return json({
        ok: true,
        ...(charsChanged ? { characters: updated.characters, equipped: updated.equipped } : {})
      });
    }

    if (action === "character_manage") {
      const operation = String(body.operation || "").trim();
      const charId = String(body.charId || "").trim();
      const state = (await dbGetJson(db, "game:" + me)) || defaultGameState(me);
      state.characters = Array.isArray(state.characters) ? state.characters : [];
      state.equipped = Array.isArray(state.equipped) ? state.equipped : [];

      const baseIds = new Set(["slime", "dust", "frog", "sloth", "doctor", "knight", "nightmare", "king"]);
      const isKnownId = baseIds.has(charId) || baseIds.has(charId.replace(/_plus$/, "")) && charId.endsWith("_plus");
      if (!isKnownId) return json({ error: "対象のキャラクターが見つかりません。" }, 400);

      const { blobs: tradeBlobs } = await db.list({ prefix: "trade:" });
      const allTrades = await Promise.all((tradeBlobs || []).map(b => dbGetJson(db, b.key)));
      const lockedUids = new Set(allTrades.filter(t => t && t.status === "open" && t.from === me).map(t => t.fromCharUid));
      const available = state.characters.filter(c => c.charId === charId && !state.equipped.includes(c.uid) && !lockedUids.has(c.uid));

      state.removedCharacterUids = Array.isArray(state.removedCharacterUids) ? state.removedCharacterUids : [];
      if (operation === "discard") {
        if (!available.length) return json({ error: "捨てられるキャラクターがありません。編成中またはトレード中のキャラは捨てられません。" }, 400);
        const target = available[0];
        state.characters = state.characters.filter(c => c.uid !== target.uid);
        state.removedCharacterUids.push(target.uid);
      } else if (operation === "synthesize") {
        if (!baseIds.has(charId)) return json({ error: "強化版キャラクターはこの合成ではさらに合成できません。" }, 400);
        if (available.length < 100) return json({ error: "合成には、編成・トレード中ではない同じキャラクターが100体必要です。" }, 400);
        const consumed = new Set(available.slice(0, 100).map(c => c.uid));
        state.characters = state.characters.filter(c => !consumed.has(c.uid));
        state.removedCharacterUids.push(...consumed);
        state.characters.push({
          uid: "c_" + Date.now().toString(36) + "_plus_" + Math.random().toString(36).slice(2, 9),
          charId: charId + "_plus",
          obtainedAt: Date.now()
        });
      } else {
        return json({ error: "不明なキャラクター操作です。" }, 400);
      }

      state.updatedAt = Date.now();
      await dbPutJson(db, "game:" + me, state);
      return json({ ok: true, state });
    }

    if (action === "trade_offer") {
      const peer = String(body.peer || "").trim();
      const myCharUid = String(body.myCharUid || "").trim();
      const wantCharId = String(body.wantCharId || "ANY").trim();

      if (!peer || peer === me) return json({ error: "有効な相手のIDを入力してください。" }, 400);
      if (peer !== "admin") {
        const peerUser = await dbGetJson(db, "user:" + peer);
        if (!peerUser || peerUser.status !== "approved") {
          return json({ error: "指定された相手IDが見つからないか、まだ許可されていません。" }, 404);
        }
      }

      const myState = (await dbGetJson(db, "game:" + me)) || defaultGameState(me);
      const offeredChar = (myState.characters || []).find(c => c.uid === myCharUid);
      if (!offeredChar) {
        return json({ error: "指定したキャラクターを所持していません。一度セーブしてから試してください。" }, 400);
      }

      const { blobs: tradeBlobs } = await db.list({ prefix: "trade:" });
      const allTrades = await Promise.all((tradeBlobs || []).map(b => dbGetJson(db, b.key)));
      for (const tr of allTrades) {
        if (tr && tr.status === "open" && tr.from === me && tr.fromCharUid === myCharUid) {
          return json({ error: "このキャラクターはすでに別のトレードに出品中です。" }, 400);
        }
      }

      const tradeId = "tr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      const tradeObj = {
        tradeId,
        from: me,
        to: peer,
        fromCharUid: offeredChar.uid,
        fromCharId: offeredChar.charId,
        wantCharId,
        status: "open",
        createdAt: Date.now()
      };
      await dbPutJson(db, "trade:" + tradeId, tradeObj);
      return json({ ok: true, trade: tradeObj });
    }

    if (action === "trade_respond") {
      const tradeId = String(body.tradeId || "").trim();
      const accept = Boolean(body.accept);
      const giveCharUid = String(body.giveCharUid || "").trim();

      const tr = await dbGetJson(db, "trade:" + tradeId);
      if (!tr || tr.status !== "open" || tr.to !== me) {
        return json({ error: "有効なトレード申請が見つかりません。" }, 404);
      }

      if (!accept) {
        tr.status = "rejected";
        await dbPutJson(db, "trade:" + tradeId, tr);
        return json({ ok: true, message: "トレードを断りました。" });
      }

      const senderState = await dbGetJson(db, "game:" + tr.from);
      const myState = (await dbGetJson(db, "game:" + me)) || defaultGameState(me);
      if (!senderState) return json({ error: "相手のセーブデータが見つかりません。" }, 404);

      const senderCharIdx = (senderState.characters || []).findIndex(c => c.uid === tr.fromCharUid);
      if (senderCharIdx === -1) {
        tr.status = "invalid";
        await dbPutJson(db, "trade:" + tradeId, tr);
        return json({ error: "相手がそのキャラをすでに手放しているため成立しませんでした。" }, 400);
      }

      const myCharIdx = (myState.characters || []).findIndex(c => c.uid === giveCharUid);
      if (myCharIdx === -1) {
        return json({ error: "交換に出す自分のキャラクターを選んでください。" }, 400);
      }
      const myGivenChar = myState.characters[myCharIdx];
      if (tr.wantCharId !== "ANY" && myGivenChar.charId !== tr.wantCharId) {
        return json({ error: "相手が希望しているキャラクターと一致しません。" }, 400);
      }

      const senderGivenChar = senderState.characters[senderCharIdx];
      senderState.characters.splice(senderCharIdx, 1, myGivenChar);
      myState.characters.splice(myCharIdx, 1, senderGivenChar);

      senderState.equipped = (senderState.equipped || []).filter(u => u !== senderGivenChar.uid);
      myState.equipped = (myState.equipped || []).filter(u => u !== myGivenChar.uid);

      tr.status = "completed";
      tr.completedAt = Date.now();

      await dbPutJson(db, "game:" + tr.from, senderState);
      await dbPutJson(db, "game:" + me, myState);
      await dbPutJson(db, "trade:" + tradeId, tr);

      return json({ ok: true, message: "トレードが成立しました！", state: myState });
    }

    if (action === "trade_cancel") {
      const tradeId = String(body.tradeId || "").trim();
      const tr = await dbGetJson(db, "trade:" + tradeId);
      if (!tr || tr.status !== "open" || tr.from !== me) {
        return json({ error: "キャンセルできるトレードが見つかりません。" }, 404);
      }
      tr.status = "cancelled";
      await dbPutJson(db, "trade:" + tradeId, tr);
      return json({ ok: true });
    }

    return json({ error: "Invalid action" }, 400);
  }

  return json({ error: "Method not allowed" }, 405);
}
