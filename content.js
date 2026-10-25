// ==========================================
// 1. FLOATING HUD UI
// ==========================================
const UI = (() => {
  let hud, moveDisplay, statusDisplay;

  function init() {
    hud = document.createElement('div');
    hud.id = 'chess-ai-hud';
    hud.innerHTML = `
      <div id="chess-ai-hud-header">
        <span>🤖 AI Engine</span>
        <span style="color:#f38ba8; cursor:pointer;" id="close-hud">✖</span>
      </div>
      <div id="chess-ai-hud-body">
        <div class="hud-status" id="hud-status">Waiting for game to start...</div>
        <div class="hud-row">
          <span class="hud-label">Best Move:</span>
          <span class="hud-value" id="hud-move">--</span>
        </div>
      </div>
    `;
    document.body.appendChild(hud);

    moveDisplay = document.getElementById('hud-move');
    statusDisplay = document.getElementById('hud-status');

    // Make it draggable
    const header = document.getElementById('chess-ai-hud-header');
    let isDragging = false, currentX, currentY, initialX, initialY, xOffset = 0, yOffset = 0;

    header.addEventListener('mousedown', dragStart);
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', dragEnd);
    document.getElementById('close-hud').onclick = () => hud.style.display = 'none';

    function dragStart(e) {
      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;
      if (e.target === header || e.target.parentNode === header) isDragging = true;
    }
    function drag(e) {
      if (isDragging) {
        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;
        xOffset = currentX; yOffset = currentY;
        hud.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
      }
    }
    function dragEnd() { isDragging = false; }
  }

  return {
    init,
    update: (status, move) => {
      if (status) statusDisplay.innerText = status;
      if (move) moveDisplay.innerText = move.toUpperCase();
    },
    clearMove: () => {
      moveDisplay.innerText = '--';
    }
  };
})();

// ==========================================
// 2. THE IFRAME ENGINE BRIDGE
// ==========================================
const iframe = document.createElement('iframe');
iframe.src = chrome.runtime.getURL('engine.html');
iframe.id = 'ai-engine-frame';
iframe.style.display = 'none';
document.body.appendChild(iframe);

window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'BEST_MOVE') {
    const move = event.data.bestMove;
    if (move) {
      const from = move.substring(0, 2);
      const to = move.substring(2, 4);
      UI.update("Best move found!", `${from} → ${to}`);
      ChessOverlay.highlightMove(from, to);
    }
  }
});

// ==========================================
// 3. QWEN'S UI OVERLAY (Ghost-Board Fix)
// ==========================================
const ChessOverlay = (() => {
  const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  
  function isFlipped() {
    const board = document.querySelector('.board') || document.querySelector('chess-board');
    return board && (board.classList.contains('flipped') || board.getAttribute('data-flipped') === 'true' || board.parentElement.classList.contains('flipped'));
  }

  function algebraicToGrid(square) {
    const col = FILES.indexOf(square[0].toLowerCase());
    const row = 8 - parseInt(square[1]);
    return isFlipped() ? { col: 7 - col, row: 7 - row } : { col, row };
  }

  function checkIsCapture(fromSq, toSq) {
    try {
      const toFile = toSq.charCodeAt(0) - 96; 
      const toRank = toSq[1];
      if (document.querySelector(`.piece.square-${toFile}${toRank}`)) return true;

      const fromFile = fromSq.charCodeAt(0) - 96;
      const fromRank = fromSq[1];
      const fromPiece = document.querySelector(`.piece.square-${fromFile}${fromRank}`);
      
      if (fromPiece && /(?:^|\s)[wb]p(?:\s|$)/.test(fromPiece.className) && fromSq[0] !== toSq[0]) {
        return true; 
      }
    } catch(e) { 
      console.warn("Capture check failed:", e); 
    }
    return false;
  }

  function highlightMove(fromSquare, toSquare) {
    let board = document.querySelector('chess-board, wc-chess-board, .board');
    if (!board) return;
    board.style.position = 'relative';

    // FIX: Dynamically grab the live overlay so it never gets stuck on a deleted board
    let overlay = document.getElementById('chess-overlay-container');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'chess-overlay-container';
      board.appendChild(overlay);
    } else if (overlay.parentNode !== board) {
      // If Chess.com deleted the board and made a new one, move the overlay to it!
      board.appendChild(overlay);
    }
    
    overlay.innerHTML = ''; 
    const isCapture = checkIsCapture(fromSquare, toSquare);

    [ 
      { sq: fromSquare, type: 'from' }, 
      { sq: toSquare, type: isCapture ? 'capture' : 'to' } 
    ].forEach(move => {
      const grid = algebraicToGrid(move.sq);
      if (!grid) return;
      
      const el = document.createElement('div');
      el.className = 'chess-highlight-square';
      el.dataset.type = move.type;
      el.style.gridColumn = `${grid.col + 1} / ${grid.col + 2}`;
      el.style.gridRow = `${grid.row + 1} / ${grid.row + 2}`;
      overlay.appendChild(el);
    });
  }

  function clearHighlights() {
    const overlay = document.getElementById('chess-overlay-container');
    if (overlay) overlay.innerHTML = '';
  }

  return { highlightMove, clearHighlights, isFlipped };
})();

// ==========================================
// 4. DEEPSEEK'S DOM PARSER 
// ==========================================
const ChessTracker = (() => {
  let debounceTimer = null;
  let lastFen = null;

  function getFen() {
    const pieces = document.querySelectorAll('.piece');
    if (pieces.length === 0) return null;
    
    const grid = new Array(64).fill(null);
    
    pieces.forEach(piece => {
      const classes = Array.from(piece.classList);
      const squareClass = classes.find(c => c.startsWith('square-'));
      if (!squareClass) return;
      
      const xy = squareClass.replace('square-', '');
      if (xy.length !== 2) return;
      
      const file = parseInt(xy[0]) - 1; 
      const rank = 8 - parseInt(xy[1]); 
      
      let color = classes.some(c => c.startsWith('w') || c.includes('white')) ? 'w' : 'b';
      
      let type = 'p';
      if (classes.some(c => c === 'wn' || c === 'bn' || c.includes('knight'))) type = 'n';
      else if (classes.some(c => c === 'wb' || c === 'bb' || c.includes('bishop'))) type = 'b';
      else if (classes.some(c => c === 'wr' || c === 'br' || c.includes('rook'))) type = 'r';
      else if (classes.some(c => c === 'wq' || c === 'bq' || c.includes('queen'))) type = 'q';
      else if (classes.some(c => c === 'wk' || c === 'bk' || c.includes('king'))) type = 'k';

      grid[rank * 8 + file] = color === 'w' ? type.toUpperCase() : type;
    });

    let fenPosition = '';
    let pieceFound = false;
    for (let rank = 0; rank < 8; rank++) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = grid[rank * 8 + file];
        if (p) { 
          if (empty > 0) { fenPosition += empty; empty = 0; } 
          fenPosition += p; 
          pieceFound = true;
        } else { empty++; }
      }
      if (empty > 0) fenPosition += empty;
      if (rank < 7) fenPosition += '/';
    }

    if (!pieceFound) return null;

    let activeColor = 'w';
    if (fenPosition !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR') {
      const highlights = document.querySelectorAll('.highlight');
      let hasHighlight = false, highlightIsWhite = false;
      highlights.forEach(hl => {
        const sqClass = Array.from(hl.classList).find(c => c.startsWith('square-'));
        if (!sqClass) return;
        const xy = sqClass.replace('square-', '');
        const file = parseInt(xy[0]) - 1;
        const rank = 8 - parseInt(xy[1]);
        const piece = grid[rank * 8 + file];
        if (piece) {
          hasHighlight = true;
          if (piece === piece.toUpperCase()) highlightIsWhite = true;
        }
      });
      if (hasHighlight) activeColor = highlightIsWhite ? 'b' : 'w';
    }

    return `${fenPosition} ${activeColor} - - 0 1`;
  }

  function handleMutations() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const fen = getFen();
      if (fen && fen !== lastFen) {
        lastFen = fen;
        
        const activeColor = fen.split(' ')[1]; 
        const playingAsBlack = ChessOverlay.isFlipped();
        
        const isUserTurn = (playingAsBlack && activeColor === 'b') || (!playingAsBlack && activeColor === 'w');

        if (isUserTurn) {
          UI.update("Calculating best move...", "--");
          document.getElementById('ai-engine-frame').contentWindow.postMessage({ type: 'ANALYZE', fen: fen }, '*');
        } else {
          UI.update("Opponent's turn...", "--");
          ChessOverlay.clearHighlights(); 
        }
      }
    }, 300); 
  }

  function start() {
    UI.init(); 
    const board = document.querySelector('chess-board, wc-chess-board, .board');
    if (!board) { setTimeout(start, 500); return; }
    
    setTimeout(handleMutations, 1000);
    const observer = new MutationObserver(handleMutations);
    observer.observe(document.body, { childList: true, attributes: true, subtree: true });
  }

  return { start };
})();

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', ChessTracker.start); } 
else { ChessTracker.start(); }