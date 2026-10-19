// World-scale annotations drawn in addition to a hex's underlying terrain.
// Codes refer to the supplied Traveller5 Terrain Symbols chart (page 47).
export const MAP_FEATURES = Object.freeze({
  starport: { label: "Starport", code: "56", mark: "SP" },
  city: { label: "City", code: "51", mark: "C" },
  town: { label: "Town", code: "55", mark: "T" },
  dome: { label: "Domed city", code: "52", mark: "D" },
  arcology: { label: "Arcology", code: "53", mark: "A" },
  suburbs: { label: "Suburbs", code: "54", mark: "S" },
  ruins: { label: "Ruins", code: "26", mark: "Ru" },
  resource: { label: "Resource", code: "85", mark: "R" },
  mine: { label: "Mine", code: "84", mark: "M" },
  oil: { label: "Oil", code: "86", mark: "O" },
  estate: { label: "Estate", code: "82", mark: "E" },
  reserve: { label: "Reserve", code: "83", mark: "Re" },
  penal: { label: "Penal colony", code: "76", mark: "P" },
  crater: { label: "Crater", code: "74", mark: "Cr" },
  volcano: { label: "Volcano", code: "81", mark: "V" },
  airpad: { label: "Airpad", code: "91", mark: "Ap" },
  airstrip: { label: "Airstrip", code: "93", mark: "As" },
  airport: { label: "Airport", code: "94", mark: "Air" },
  highway: { label: "Highway", code: "61", mark: "H" },
  road: { label: "Road", code: "62", mark: "Rd" },
  trail: { label: "Trail", code: "63", mark: "Tr" },
  airCorridor: { label: "Air corridor", code: "64", mark: "AC" },
  grid: { label: "Grid", code: "65", mark: "G" },
  highSpeed: { label: "High speed route", code: "66", mark: "HS" }
});

export function renderMapFeatures(features = [], x, y) {
  const entries = features.slice(0, 4);
  return entries.map((key, index) => {
    const style = MAP_FEATURES[key];
    if (!style) return "";
    const small = entries.length > 1;
    const px = x + (small ? (index % 2 ? 4 : -4) : 0);
    const py = y + (small ? (Math.floor(index / 2) ? 4 : -4) : 0);
    const r = small ? 3.6 : 5.5;
    return `<g data-feature="${key}" pointer-events="none"><title>${style.label}${features.length > 4 ? ` (+${features.length - 4} other features)` : ""}</title><rect x="${px - r}" y="${py - r}" width="${r * 2}" height="${r * 2}" rx="1" fill="#fff" fill-opacity="0.93" stroke="#152936" stroke-width="0.6"/><text x="${px}" y="${py + r * 0.45}" font-family="sans-serif" font-weight="bold" text-anchor="middle" font-size="${r * (style.mark.length > 2 ? 0.85 : 1.1)}" fill="#152936" stroke="none">${style.mark}</text></g>`;
  }).join("");
}
