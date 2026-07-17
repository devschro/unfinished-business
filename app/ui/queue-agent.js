(() => {
  'use strict';

  const mount = document.getElementById('queue-agent-mount');
  if (!mount) return;

  mount.innerHTML = `
    <svg class="orchestration-map" viewBox="0 0 240 190" role="img" aria-labelledby="orchestration-title orchestration-desc">
      <title id="orchestration-title">Queue orchestration status</title>
      <desc id="orchestration-desc">A coordinator routes work through five agents to execution and verification.</desc>
      <defs>
        <linearGradient id="panel-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#20242c" />
          <stop offset="1" stop-color="#171a20" />
        </linearGradient>
        <filter id="soft-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <style>
        .orchestration-map { --signal: #2a78d6; --signal-soft: #6cbfe6; --muted: #565d69; }
        .frame { fill: url(#panel-fill); stroke: #303540; stroke-width: 1; }
        .grid { stroke: #242932; stroke-width: 1; opacity: .65; }
        .route { fill: none; stroke: var(--muted); stroke-width: 1.5; stroke-dasharray: 4 5; opacity: .75; }
        .route.hot { stroke: var(--signal); opacity: 1; }
        .agent-shell { fill: #22262e; stroke: #505866; stroke-width: 1.2; }
        .agent-core { fill: #88919f; }
        .agent-index, .map-label { fill: #89919e; font: 600 8px ui-monospace, monospace; letter-spacing: .08em; }
        .map-label { fill: #68717e; font-size: 7px; }
        .coordinator { fill: #171a20; stroke: var(--signal-soft); stroke-width: 1.6; }
        .coordinator-core { fill: var(--signal); }
        .queue-card { fill: #252a33; stroke: #525b69; }
        .queue-line { stroke: #87909e; stroke-width: 1.3; }
        .verify-ring { fill: #19211d; stroke: #31cd49; stroke-width: 1.6; }
        .verify-check { fill: none; stroke: #31cd49; stroke-width: 2.3; stroke-linecap: round; stroke-linejoin: round; }
        .attention-ring { fill: none; stroke: #fab219; stroke-width: 2; opacity: 0; }
        [data-mode="working"] { --signal: #2a78d6; --signal-soft: #6cbfe6; }
        [data-mode="needsYou"] { --signal: #d99613; --signal-soft: #fab219; }
        [data-mode="paused"] { --signal: #7b818b; --signal-soft: #a0a6b0; }
        [data-mode="paused"] .route { opacity: .35; }
        [data-mode="needsYou"] .attention-ring { opacity: .9; }
        [data-mode="idle"] .route.hot { stroke: #596271; opacity: .6; }
      </style>

      <rect class="frame" x="5" y="5" width="230" height="180" rx="18" />
      <path class="grid" d="M24 36H216M24 72H216M24 108H216M24 144H216M60 20V170M120 20V170M180 20V170" />

      <g aria-hidden="true">
        <path class="route hot" data-route d="M39 95H83" />
        <path class="route hot" data-route d="M104 84L135 49M104 90L135 83M104 100L135 116M104 106L135 150" />
        <path class="route hot" data-route d="M155 49L194 80M155 83L194 88M155 116L194 101M155 150L194 109" />
      </g>

      <g transform="translate(18 75)">
        <rect class="queue-card" x="0" y="0" width="28" height="40" rx="6" />
        <path class="queue-line" d="M7 10H21M7 18H18M7 26H21M7 34H15" />
        <text class="map-label" x="14" y="52" text-anchor="middle">QUEUE</text>
      </g>

      <g class="coordinator-node" transform="translate(94 95)">
        <circle class="attention-ring" r="18" />
        <path class="coordinator" d="M0-15L15 0 0 15-15 0Z" />
        <circle class="coordinator-core" r="4" />
        <text class="map-label" x="0" y="29" text-anchor="middle">ROUTE</text>
      </g>

      <g class="agent-node" data-agent transform="translate(145 48)">
        <circle class="agent-shell" r="13" /><circle class="agent-core" r="4" /><text class="agent-index" x="0" y="3" text-anchor="middle">1</text>
      </g>
      <g class="agent-node" data-agent transform="translate(145 82)">
        <circle class="agent-shell" r="13" /><circle class="agent-core" r="4" /><text class="agent-index" x="0" y="3" text-anchor="middle">2</text>
      </g>
      <g class="agent-node" data-agent transform="translate(145 116)">
        <circle class="agent-shell" r="13" /><circle class="agent-core" r="4" /><text class="agent-index" x="0" y="3" text-anchor="middle">3</text>
      </g>
      <g class="agent-node" data-agent transform="translate(145 150)">
        <circle class="agent-shell" r="13" /><circle class="agent-core" r="4" /><text class="agent-index" x="0" y="3" text-anchor="middle">4</text>
      </g>

      <g class="verify-node" transform="translate(205 95)">
        <circle class="verify-ring" r="17" />
        <path class="verify-check" d="M-8 0L-2 6 9-7" />
        <text class="map-label" x="0" y="30" text-anchor="middle">VERIFY</text>
      </g>
    </svg>`;

  const svg = mount.querySelector('svg');
  const routes = [...mount.querySelectorAll('[data-route]')];
  const agents = [...mount.querySelectorAll('[data-agent]')];
  const coordinator = mount.querySelector('.coordinator-node');
  const attention = mount.querySelector('.attention-ring');
  const verify = mount.querySelector('.verify-node');
  const check = mount.querySelector('.verify-check');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let animations = [];
  let mode = 'idle';

  function stopAnimations() {
    for (const animation of animations) animation.cancel();
    animations = [];
  }

  function play(nextMode) {
    stopAnimations();
    if (reducedMotion.matches) return;

    if (nextMode === 'working') {
      routes.forEach((route, index) => {
        animations.push(route.animate(
          [{ strokeDashoffset: '18', opacity: .4 }, { strokeDashoffset: '0', opacity: 1 }],
          { duration: 760, delay: index * 70, iterations: 2, easing: 'ease-out' },
        ));
      });
      agents.forEach((agent, index) => {
        animations.push(agent.animate(
          [{ opacity: .55 }, { opacity: 1, filter: 'drop-shadow(0 0 5px #2a78d6)' }, { opacity: .75 }],
          { duration: 620, delay: 180 + index * 130, iterations: 1, easing: 'ease-in-out' },
        ));
      });
      animations.push(coordinator.animate(
        [{ transform: 'translate(94px, 95px) scale(1)' }, { transform: 'translate(94px, 95px) scale(1.12)' }, { transform: 'translate(94px, 95px) scale(1)' }],
        { duration: 720, iterations: 2, easing: 'ease-in-out' },
      ));
    } else if (nextMode === 'needsYou') {
      animations.push(attention.animate(
        [{ opacity: .9, r: '17' }, { opacity: .15, r: '25' }],
        { duration: 900, iterations: 2, easing: 'ease-out' },
      ));
    } else if (nextMode === 'idle') {
      animations.push(coordinator.animate(
        [{ opacity: .7 }, { opacity: 1 }],
        { duration: 520, iterations: 1, easing: 'ease-out' },
      ));
    }
  }

  function setMode(nextMode) {
    const allowed = new Set(['working', 'idle', 'paused', 'needsYou']);
    const normalized = allowed.has(nextMode) ? nextMode : 'idle';
    if (normalized === mode && animations.some(a => a.playState === 'running')) return;
    mode = normalized;
    svg.dataset.mode = mode;
    play(mode);
  }

  function celebrate() {
    stopAnimations();
    svg.dataset.mode = 'idle';
    if (!reducedMotion.matches) {
      animations.push(verify.animate(
        [{ transform: 'translate(205px, 95px) scale(.85)' }, { transform: 'translate(205px, 95px) scale(1.2)' }, { transform: 'translate(205px, 95px) scale(1)' }],
        { duration: 900, iterations: 1, easing: 'cubic-bezier(.2,.9,.2,1)' },
      ));
      animations.push(check.animate(
        [{ strokeDasharray: '28', strokeDashoffset: '28' }, { strokeDasharray: '28', strokeDashoffset: '0' }],
        { duration: 620, iterations: 1, easing: 'ease-out' },
      ));
    }
    window.setTimeout(() => {
      svg.dataset.mode = mode;
      play(mode);
    }, reducedMotion.matches ? 0 : 1100);
  }

  reducedMotion.addEventListener('change', () => play(mode));
  svg.dataset.mode = mode;
  window.QueueAgent = Object.freeze({ setMode, celebrate });
})();
