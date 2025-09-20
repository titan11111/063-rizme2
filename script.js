(() => {
  // ------- helpers
  const qs = (s, root=document) => root.querySelector(s);
  const qsa = (s, root=document) => [...root.querySelectorAll(s)];
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  // ------- state
  const state = {
    score: 0,
    combo: 0,
    maxCombo: 0,
    judge: '',
    results: { perfect: 0, great: 0, good: 0, miss: 0 },
    notes: [],
    isGameRunning: false,
    pixelsPerSec: 520,   // ノートの落下速度（px/s）
    lastNoteTime: 0
  };

  const KEY_MAPPINGS = { 'a':0, 's':1, ' ':2 };
  const JUDGE_RANGES = { perfect:0.15, great:0.25, good:0.40 }; // やさしめ
  const SCORE_VALUES = { perfect:100, great:50, good:20 };

  // ------- elements
  const btnStart = qs('#btnStart');
  const btnHow = qs('#btnHow');
  const howSection = qs('#howSection');
  const music = qs('#gameMusic');
  const canvas = qs('#gameCanvas');
  const ctx = canvas.getContext('2d');
  let dpr = Math.max(1, window.devicePixelRatio || 1);
  const hudScore = qs('#score');
  const hudCombo = qs('#combo');
  const judgeText = qs('#judgeText');

  // ------- animation
  let lastFrameTime = 0;
  let animationFrameId;

  // ------- difficulty
  const DIFFICULTIES = {
    easy:   { speed: 0.9, pps: 420 },
    normal: { speed: 1.0, pps: 520 },
    hard:   { speed: 1.2, pps: 600 }
  };

  // ------- start game
  async function startGame() {
    const difficulty = qs('input[name="diff"]:checked').value;
    const diff = DIFFICULTIES[difficulty] || DIFFICULTIES.easy;

    // reset
    state.score = 0; 
    state.combo = 0; 
    state.maxCombo = 0; 
    state.judge = '';
    state.results = { perfect:0, great:0, good:0, miss:0 };
    state.notes = []; 
    state.isGameRunning = true;
    state.pixelsPerSec = diff.pps;

    updateHUD();
    judgeText.textContent = '';
    showScene('play');

    // 音源（エラー時も続行）
    try { 
      await music.play(); 
    } catch(e) { 
      console.warn('BGMを再生できませんでした:', e); 
    }
    music.currentTime = 0;

    // 譜面読み込み（JSON優先 → 失敗時ランダム）
    await loadNotesFromJSON().catch(()=>{
      console.log('notes.jsonが読み込めませんでした。ランダム譜面を生成します。');
    });
    if (state.notes.length === 0) {
      generateNotesFallback();
    }

    // last note
    state.lastNoteTime = Math.max(0, ...state.notes.map(n=>n.time||0));

    // loop
    lastFrameTime = performance.now();
    cancelAnimationFrame(animationFrameId);
    animationFrameId = requestAnimationFrame(gameLoop);
  }

  // ------- notes: JSON load
  async function loadNotesFromJSON(){
    try {
      const res = await fetch('./notes.json', {cache:'no-store'});
      if(!res.ok) throw new Error('notes.json load failed');
      const data = await res.json();
      state.notes = data
        .filter(n => typeof n.time==='number' && (n.lane===0||n.lane===1||n.lane===2))
        .map(n => ({ time: n.time, lane: n.lane, alive: true, y: -100 }));
    } catch(e) {
      throw new Error('JSONファイルの読み込みに失敗しました');
    }
  }

  // ------- notes: fallback (ランダム)
  function generateNotesFallback(){
    const duration = 42; // 安全な既定値
    let t = 2.0;
    while(t < duration){
      if(Math.random() < 0.5){
        const lane = Math.floor(Math.random()*3);
        state.notes.push({ time:t, lane, alive:true, y:-100 });
      }
      t += 0.5;
    }
  }

  // ------- loop
  function gameLoop(now){
    const dt = (now - lastFrameTime)/1000; 
    lastFrameTime = now;
    if(state.isGameRunning){
      updateNotes();
      updateStickman(dt);
      draw();
      if(shouldEnd()) endGame();
    }
    animationFrameId = requestAnimationFrame(gameLoop);
  }

  // ------- end condition
  function shouldEnd(){
    const allDone = state.notes.every(n => !n.alive);
    return music.ended || (allDone && music.currentTime > state.lastNoteTime + 1.5);
  }

  // ------- end game
  function endGame(){
    state.isGameRunning = false;
    music.pause();
    
    // 結果表示
    qs('#rPerfect').textContent = state.results.perfect;
    qs('#rGreat').textContent = state.results.great;
    qs('#rGood').textContent = state.results.good;
    qs('#rMiss').textContent = state.results.miss;
    
    // ランク計算
    const total = state.results.perfect + state.results.great + state.results.good + state.results.miss;
    const perfectRate = total > 0 ? state.results.perfect / total : 0;
    let rank = 'D';
    if(perfectRate >= 0.95) rank = 'S';
    else if(perfectRate >= 0.85) rank = 'A';
    else if(perfectRate >= 0.70) rank = 'B';
    else if(perfectRate >= 0.50) rank = 'C';
    
    qs('#rRank').textContent = rank;
    showScene('result');
  }

  // ------- notes update (music.currentTimeベース)
  function updateNotes(){
    const laneHitY = canvas.height / dpr - 100; // 判定ラインのY
    const t = music.currentTime;

    state.notes.forEach(note=>{
      if(!note.alive) return;
      const dy = (t - note.time) * state.pixelsPerSec;
      note.y = laneHitY - dy;

      // 判定ラインを大きく上に通過したらミス
      if(note.y < -160){
        note.alive = false;
        state.results.miss++; 
        state.combo = 0; 
        state.judge = 'MISS';
        updateHUD();
      }
    });
  }

  // ------- hit
  function hitNote(lane){
    if(!state.isGameRunning) return;

    let best=null, min=Infinity;
    const t = music.currentTime;

    state.notes.forEach(n=>{
      if(n.alive && n.lane===lane){
        const diff=Math.abs(t - n.time);
        if(diff<min){ min=diff; best=n; }
      }
    });

    if(best && min<=JUDGE_RANGES.good){
      let judge, sc;
      if(min<=JUDGE_RANGES.perfect){ 
        judge='PERFECT'; 
        sc=SCORE_VALUES.perfect; 
        state.results.perfect++; 
      }
      else if(min<=JUDGE_RANGES.great){ 
        judge='GREAT'; 
        sc=SCORE_VALUES.great; 
        state.results.great++; 
      }
      else { 
        judge='GOOD'; 
        sc=SCORE_VALUES.good; 
        state.results.good++; 
      }

      state.score += sc * (1 + state.combo * 0.05);
      state.combo++; 
      state.maxCombo = Math.max(state.maxCombo, state.combo);
      state.judge = judge; 
      best.alive=false; 
      playSpark(lane);
      updateHUD();
      doStickmanAction(lane);
    } else {
      state.combo=0; 
      state.results.miss++; 
      state.judge='MISS'; 
      updateHUD();
    }
  }

  // ------- stickman
  const stick = { 
    width:30, 
    height:60, 
    color:'#06b6d4', 
    vy:0, 
    onGround:true, 
    actionTime:0, 
    currentAction:'idle' 
  };
  
  function doStickmanAction(lane){
    if(lane===0) stick.currentAction='punch';
    else if(lane===1) stick.currentAction='kick';
    else if(lane===2 && stick.onGround){ 
      stick.vy=200; 
      stick.onGround=false; 
      stick.currentAction='jump'; 
    }
    stick.actionTime = performance.now();
  }
  
  function updateStickman(dt){
    if(!stick.onGround){ 
      stick.vy -= 400*dt; 
    }
    const sy = groundY() - stick.height - stick.vy;
    if(!stick.onGround && sy >= groundY() - stick.height){ 
      stick.vy=0; 
      stick.onGround=true; 
    }
    if(performance.now() - stick.actionTime > 200 && stick.onGround){ 
      stick.currentAction='idle'; 
    }
  }
  
  function drawStickman(){
    ctx.fillStyle = stick.color; 
    ctx.strokeStyle = stick.color; 
    ctx.lineWidth = 4; 
    ctx.lineCap='round';
    
    const sx = canvas.width/dpr * 0.5;
    const sy = groundY() - stick.height - stick.vy;

    const actionDuration = performance.now() - stick.actionTime;
    const p = clamp(actionDuration/200, 0, 1);

    // head
    ctx.beginPath(); 
    ctx.arc(sx, sy, 15, 0, Math.PI*2); 
    ctx.fill();
    
    // body
    ctx.beginPath(); 
    ctx.moveTo(sx, sy+15); 
    ctx.lineTo(sx, sy+40); 
    ctx.stroke();
    
    // legs
    ctx.beginPath();
    let k = 15*p;
    if(stick.currentAction==='kick'){
      ctx.moveTo(sx, sy+40); ctx.lineTo(sx-15, sy+55);
      ctx.moveTo(sx, sy+40); ctx.lineTo(sx+15+k, sy+55 + k*0.5);
    }else if(stick.currentAction==='jump'){
      ctx.moveTo(sx, sy+40); ctx.lineTo(sx-20, sy+60);
      ctx.moveTo(sx, sy+40); ctx.lineTo(sx+20, sy+60);
    }else{
      ctx.moveTo(sx, sy+40); ctx.lineTo(sx-15, sy+55);
      ctx.moveTo(sx, sy+40); ctx.lineTo(sx+15, sy+55);
    }
    ctx.stroke();
    
    // arms
    ctx.beginPath();
    let pu = 20*p;
    if(stick.currentAction==='punch'){
      ctx.moveTo(sx, sy+25); ctx.lineTo(sx-20, sy+40);
      ctx.moveTo(sx, sy+25); ctx.lineTo(sx+20+pu, sy+40 - pu*0.5);
    }else if(stick.currentAction==='jump'){
      ctx.moveTo(sx, sy+25); ctx.lineTo(sx-25, sy+15);
      ctx.moveTo(sx, sy+25); ctx.lineTo(sx+25, sy+15);
    }else{
      ctx.moveTo(sx, sy+25); ctx.lineTo(sx-20, sy+40);
      ctx.moveTo(sx, sy+25); ctx.lineTo(sx+20, sy+40);
    }
    ctx.stroke();
  }
  
  function groundY(){ 
    return (canvas.height / dpr) - 60; 
  }

  // ------- draw
  function draw(){
    ctx.clearRect(0,0,canvas.width,canvas.height);

    const laneHitY = canvas.height/dpr - 100;
    const canvasRect = canvas.getBoundingClientRect();
    const laneEls = qsa('.lane');

    // ノート描画
    state.notes.forEach(n=>{
      if(!n.alive) return;
      const laneEl = laneEls[n.lane];
      const r = laneEl.getBoundingClientRect();
      const x = (r.left + r.width/2) - canvasRect.left; // CSS px座標
      const y = laneHitY - (n.time - music.currentTime) * state.pixelsPerSec;
      
      // ノートの色を変える
      ctx.fillStyle = n.lane === 0 ? '#68e1ff' : n.lane === 1 ? '#4ade80' : '#fbbf24';
      ctx.beginPath(); 
      ctx.arc(x, y, 16, 0, Math.PI*2); 
      ctx.fill();
    });

    drawStickman();
  }

  // ------- HUD / UI
  function updateHUD(){
    hudScore.textContent = Math.floor(state.score);
    hudCombo.textContent = state.combo>0 ? `${state.combo} COMBO` : '';
    hudCombo.classList.toggle('hit', state.combo>0);

    if(state.judge){
      const el = judgeText;
      el.textContent = state.judge;
      el.className = `judge-text judge-${state.judge.toLowerCase()}`;
      void el.offsetWidth; 
      el.style.animation='none'; 
      el.style.opacity='0';
      setTimeout(()=>{ 
        el.style.animation=''; 
        el.style.animation='judgePop .6s cubic-bezier(.25,.46,.45,.94) forwards'; 
      }, 10);
      state.judge = '';
    }
  }

  function playSpark(lane){
    const spark = qs(`.lane[data-lane="${lane}"] .spark`);
    spark.classList.add('show'); 
    setTimeout(()=>spark.classList.remove('show'), 300);
  }

  function fitCanvas(){
    const rect = canvas.getBoundingClientRect();
    ctx.setTransform(1,0,0,1,0,0);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }

  function showScene(id){ 
    qsa('.scene').forEach(s=>s.classList.remove('active')); 
    qs('#scene-'+id).classList.add('active'); 
  }

  // ------- events
  const resizeObserver = new ResizeObserver(()=>{ 
    dpr = Math.max(1, window.devicePixelRatio || 1); 
    fitCanvas(); 
  });
  resizeObserver.observe(canvas); 
  window.addEventListener('resize', fitCanvas); 
  fitCanvas();

  btnStart.addEventListener('click', startGame);
  btnHow.addEventListener('click', ()=>{ 
    howSection.style.display = howSection.style.display==='none' ? 'block' : 'none'; 
  });
  qs('#retry').addEventListener('click', ()=>{ 
    showScene('start'); 
  });
  qs('#restart').addEventListener('click', ()=>{ 
    showScene('start'); 
  });
  qs('#toEnding').addEventListener('click', ()=>{ 
    showScene('ending'); 
  });

  qsa('.ctl').forEach(btn=>{
    btn.addEventListener('touchstart', (e)=>{ 
      e.preventDefault(); 
      hitNote(parseInt(btn.dataset.lane)); 
    });
    btn.addEventListener('click', ()=>{ 
      hitNote(parseInt(btn.dataset.lane)); 
    });
  });
  
  window.addEventListener('keydown', (e)=>{
    if(!qs('#scene-play').classList.contains('active')) return;
    const lane = KEY_MAPPINGS[e.key.toLowerCase()];
    if(lane!==undefined) hitNote(lane);
  });

  // 音源エラー時はサイレントで継続可能
  music.addEventListener('error', ()=>{ 
    console.warn('BGMを読み込めませんでした。music.mp3 を確認してください。'); 
  });
})();