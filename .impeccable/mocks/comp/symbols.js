// The collective's shared symbol set. Every plate reuses these and nothing else.
const STAR = "50,0 57.8,21 75,6.7 71.2,28.8 93.3,25 79,42.2 100,50 79,57.8 93.3,75 71.2,71.2 75,93.3 57.8,79 50,100 42.2,79 25,93.3 28.8,71.2 6.7,75 21,57.8 0,50 21,42.2 6.7,25 28.8,28.8 25,6.7 42.2,21";
const SYM = {
  stairs: (c) => `<svg viewBox="0 0 100 100"><path fill="${c}" d="M0 100V66h34V33h33V0h33v100z"/></svg>`,
  star: (c) => `<svg viewBox="0 0 100 100"><polygon fill="${c}" points="${STAR}"/></svg>`,
  eye: (c, i = "#f7f4ed") => `<svg viewBox="0 0 100 60"><path fill="${c}" d="M0 30C22 -2 78 -2 100 30 78 62 22 62 0 30z"/><circle cx="50" cy="30" r="13" fill="${i}"/></svg>`,
  hourglass: (c) => `<svg viewBox="0 0 100 100"><path fill="${c}" d="M0 0h100L50 50zM0 100h100L50 50z"/></svg>`,
  circle: (c) => `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="${c}"/></svg>`,
  diamond: (c) => `<svg viewBox="0 0 100 100"><path fill="${c}" d="M50 0 100 50 50 100 0 50z"/></svg>`,
  plus: (c) => `<svg viewBox="0 0 100 100"><path fill="${c}" d="M38 0h24v38h38v24H62v38H38V62H0V38h38z"/></svg>`,
  arrow: (c) => `<svg viewBox="0 0 100 100"><path fill="${c}" d="M0 38h55V14l45 36-45 36V62H0z"/></svg>`,
  down: (c) => `<svg viewBox="0 0 100 100"><path fill="${c}" d="M38 0h24v55h24L50 100 14 55h24z"/></svg>`,
};
const MARK = (ink, stroke) => `<svg viewBox="0 0 128 128"><text x="34" y="108" font-family="Iowan Old Style, Georgia, serif" font-style="italic" font-weight="500" font-size="140" fill="${ink}">P</text><rect x="22" y="116" width="84" height="5" fill="${stroke}"/></svg>`;
document.querySelectorAll("[data-mark]").forEach((el) => { const [ink, stroke] = el.dataset.mark.split("|"); el.innerHTML = MARK(ink, stroke); const s = el.dataset.size || "44"; const svg = el.querySelector("svg"); svg.style.width = s + "px"; svg.style.height = s + "px"; });
document.querySelectorAll("[data-sym]").forEach((el) => {
  const [name, color, inner] = el.dataset.sym.split("|");
  el.innerHTML = SYM[name](color, inner);
  const s = el.dataset.size || "64";
  el.querySelector("svg").style.width = s + "px";
  el.querySelector("svg").style.height = name === "eye" ? (s * 0.6) + "px" : s + "px";
});
