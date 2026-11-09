'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  // ---------- Preferências locais (só conveniência; pode falhar em aba anônima) ----------
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignora */ } },
  };

  function randomId() {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // Identidade do jogador: mantém o mesmo id depois de F5, para não perder o voto.
  let playerId = store.get('pp.playerId');
  if (!playerId) {
    playerId = randomId();
    store.set('pp.playerId', playerId);
  }

  const socket = io();
  let state = null;
  let roomId = new URLSearchParams(location.search).get('room');
  let joined = false;
  let joinInfo = null;

  // ---------- Helpers de UI ----------
  function show(screen) {
    for (const id of ['home', 'name-screen', 'room']) $(id).classList.toggle('hidden', id !== screen);
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value; // textContent: nada de HTML vindo do usuário
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }

  let toastTimer;
  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2200);
  }

  function goToRoom(id) {
    roomId = id;
    history.replaceState(null, '', `?room=${encodeURIComponent(id)}`);
    $('player-name').value = store.get('pp.name') || '';
    show('name-screen');
    $('player-name').focus();
  }

  // ---------- Tela inicial ----------
  fetch('/api/decks')
    .then((r) => r.json())
    .then((decks) => {
      for (const [key, deck] of Object.entries(decks)) {
        $('deck').append(el('option', { value: key, text: `${deck.label} (${deck.cards.join(', ')})` }));
      }
    });

  $('create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    socket.emit('create-room', {
      name: $('game-name').value,
      deck: $('deck').value,
      onlyFacilitatorReveal: $('only-facilitator').checked,
      playerId,
    }, (res) => {
      if (res?.error) return ($('home-error').textContent = res.error);
      goToRoom(res.roomId);
    });
  });

  $('join-code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('join-code').value.trim().toUpperCase();
    if (code) goToRoom(code);
  });

  // ---------- Entrar na sala ----------
  function join(info) {
    socket.emit('join', { roomId, playerId, ...info }, (res) => {
      if (res?.error) {
        joined = false;
        if ($('room').classList.contains('hidden')) {
          $('name-error').textContent = res.error;
        } else {
          toast(res.error);
          history.replaceState(null, '', '/');
          show('home');
        }
        return;
      }
      joined = true;
      joinInfo = info;
      show('room');
    });
  }

  $('name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('player-name').value.trim();
    if (!name) return;
    store.set('pp.name', name);
    $('name-error').textContent = '';
    join({ name, spectator: $('spectator').checked });
  });

  // Reconecta sozinho se a rede cair ou o servidor reiniciar.
  socket.on('connect', () => {
    $('connection').classList.add('hidden');
    if (joined && joinInfo) join(joinInfo);
  });
  socket.on('disconnect', () => $('connection').classList.remove('hidden'));

  // ---------- Ações da sala ----------
  $('copy-link').addEventListener('click', async () => {
    const link = `${location.origin}/?room=${state?.id || roomId}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Link copiado!');
    } catch {
      prompt('Copie o link:', link);
    }
  });

  $('toggle-spectator').addEventListener('click', () => {
    const me = state?.players.find((p) => p.id === playerId);
    if (!me) return;
    joinInfo = { ...joinInfo, spectator: !me.spectator };
    socket.emit('set-spectator', { spectator: !me.spectator });
  });

  const toggleIssues = () => $('issues').classList.toggle('hidden');
  $('toggle-issues').addEventListener('click', toggleIssues);
  $('close-issues').addEventListener('click', toggleIssues);

  $('issue-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('issue-title').value.trim();
    if (!title) return;
    socket.emit('add-issue', { title });
    $('issue-title').value = '';
  });

  // ---------- Renderização ----------
  socket.on('state', (s) => {
    state = s;
    render();
  });

  function render() {
    const s = state;
    const me = s.players.find((p) => p.id === playerId);
    document.title = s.name === 'Planning Poker' ? s.name : `${s.name} · Planning Poker`;
    $('room-name').textContent = s.name;
    $('room-code').textContent = s.id;
    $('toggle-spectator').textContent = me?.spectator ? 'Virar jogador' : 'Virar espectador';
    $('toggle-issues').textContent = `Issues (${s.issues.length})`;

    renderCurrentIssue(s);
    renderPlayers(s);
    renderTableCenter(s);
    renderResults(s);
    renderHand(s, me);
    renderIssues(s);
  }

  function renderCurrentIssue(s) {
    const issue = s.issues.find((i) => i.id === s.currentIssueId);
    $('current-issue').classList.toggle('hidden', !issue);
    $('current-issue').textContent = issue ? `Votando: ${issue.title}` : '';
  }

  function renderPlayers(s) {
    const top = $('players-top');
    const bottom = $('players-bottom');
    top.replaceChildren();
    bottom.replaceChildren();

    s.players.forEach((p, index) => {
      let slot;
      if (p.spectator) slot = el('div', { class: 'slot spectator', text: '👁', title: 'Espectador' });
      else if (s.revealed && p.vote !== null) slot = el('div', { class: 'slot shown', text: p.vote });
      else if (p.hasVoted) slot = el('div', { class: 'slot voted' });
      else slot = el('div', { class: 'slot' });

      const label = (p.id === s.facilitatorId ? '★ ' : '') + p.name;
      const classes = ['player', p.online ? '' : 'offline', p.id === playerId ? 'me' : ''].join(' ');
      const node = el('div', { class: classes, title: p.online ? p.name : `${p.name} (desconectado)` }, [
        slot,
        el('span', { class: 'name', text: label }),
      ]);
      (index % 2 === 0 ? top : bottom).append(node);
    });
  }

  function renderTableCenter(s) {
    const center = $('table-center');
    center.replaceChildren();
    const voters = s.players.filter((p) => !p.spectator);
    const voted = voters.filter((p) => p.hasVoted).length;

    if (s.revealed) {
      center.append(s.canControl
        ? el('button', { class: 'primary', text: 'Nova votação', onclick: () => socket.emit('reset') })
        : el('span', { class: 'muted', text: 'Aguardando nova votação' }));
      return;
    }

    if (voted === 0) {
      center.append(el('span', { class: 'muted', text: 'Escolham suas cartas!' }));
      return;
    }

    center.append(el('div', {}, [
      s.canControl
        ? el('button', { class: 'primary', text: 'Revelar cartas', onclick: () => socket.emit('reveal') })
        : el('span', { class: 'muted', text: 'Aguardando o facilitador revelar' }),
      el('div', { class: 'muted', style: 'margin-top:8px;font-size:13px', text: `${voted} de ${voters.length} votaram` }),
    ]));
  }

  function renderResults(s) {
    const box = $('results');
    box.replaceChildren();
    const summary = s.summary;
    box.classList.toggle('hidden', !s.revealed);
    if (!summary) return;

    if (summary.totalVotes === 0) {
      box.append(el('span', { class: 'muted', text: 'Ninguém votou nesta rodada.' }));
      return;
    }

    box.append(el('div', { class: 'stat' }, [
      el('div', { class: 'value', text: summary.average !== null ? String(summary.average).replace('.', ',') : summary.mostVoted }),
      el('div', { class: 'label', text: summary.average !== null ? 'Média' : 'Mais votada' }),
    ]));

    if (summary.consensus) box.append(el('div', { class: 'consensus', text: '🎉 Consenso!' }));

    const max = Math.max(...Object.values(summary.counts));
    const bars = el('div', { class: 'bars' });
    for (const card of s.deck.cards) {
      const count = summary.counts[card];
      if (!count) continue;
      bars.append(el('div', { class: 'bar' }, [
        el('span', { text: String(count) }),
        el('div', { class: 'fill', style: `height:${Math.round((count / max) * 60)}px` }),
        el('span', { class: 'card-label', text: card }),
      ]));
    }
    box.append(bars);
  }

  function renderHand(s, me) {
    const hand = $('hand');
    hand.replaceChildren();
    const spectator = !me || me.spectator;
    $('spectator-note').classList.toggle('hidden', !spectator);
    hand.classList.toggle('hidden', spectator || s.revealed);
    if (spectator) return;

    for (const card of s.deck.cards) {
      const selected = me.vote === card;
      hand.append(el('button', {
        class: `card${selected ? ' selected' : ''}`,
        text: card,
        'aria-pressed': String(selected),
        onclick: () => socket.emit('vote', { card: selected ? null : card }),
      }));
    }
  }

  function renderIssues(s) {
    const list = $('issue-list');
    list.replaceChildren();

    for (const issue of s.issues) {
      const current = issue.id === s.currentIssueId;
      const row = el('div', { class: 'row' });

      if (s.canControl) {
        row.append(el('button', {
          text: current ? 'Votando' : 'Votar esta',
          disabled: current ? 'disabled' : null,
          onclick: () => socket.emit('select-issue', { issueId: issue.id }),
        }));
        row.append(el('button', {
          class: 'remove',
          text: 'Remover',
          onclick: () => socket.emit('remove-issue', { issueId: issue.id }),
        }));

        const select = el('select', {
          title: 'Estimativa',
          onchange: (e) => socket.emit('set-estimate', { issueId: issue.id, estimate: e.target.value || null }),
        });
        select.append(el('option', { value: '', text: '—' }));
        for (const card of s.deck.cards) {
          const option = el('option', { value: card, text: card });
          if (issue.estimate === card) option.selected = true;
          select.append(option);
        }
        row.append(select);
      } else {
        row.append(el('span', { class: 'muted', text: `Estimativa: ${issue.estimate ?? '—'}` }));
      }

      list.append(el('li', { class: `issue${current ? ' current' : ''}` }, [
        el('span', { class: 'issue-title', text: issue.title }),
        row,
      ]));
    }

    const total = s.issues.map((i) => Number(i.estimate === '½' ? 0.5 : i.estimate)).filter(Number.isFinite).reduce((a, b) => a + b, 0);
    $('issues-total').textContent = s.issues.length
      ? `${s.issues.filter((i) => i.estimate !== null).length} de ${s.issues.length} estimadas${total ? ` · total ${total} pts` : ''}`
      : 'Nenhuma issue ainda.';
  }

  // ---------- Início ----------
  if (roomId) goToRoom(roomId.toUpperCase());
  else show('home');
})();
