// Pure geometry: a frequency-size icosahedral grid, unfolded into Traveller's
// five-column net. Surface cells are dual to the subdivided triangular lattice.
// One cell may have several clipped drawing fragments; these are not new cells.
const EHEX = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const SQRT3 = Math.sqrt(3);
const escapeXml = value => String(value ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function parseWorldSize(value) {
  let size = value;
  if (typeof size === "string") {
    const text = size.trim().toUpperCase();
    size = /^\d+$/.test(text) ? Number(text) : text.length === 1 ? EHEX.indexOf(text) : NaN;
  }
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size >= EHEX.length) {
    throw new Error("World size must be a valid numeric or extended-hex UWP size.");
  }
  return size;
}

export function buildWorldGrid(value) {
  const size = parseWorldSize(value);
  if (size === 0) return null;
  const spacing = 24, side = size * spacing, height = side * SQRT3 / 2;
  const width = 5 * side;
  const cells = new Map(), faces = [];
  const wrap = i => (i + 5) % 5;
  const vertex = (id, x, y) => ({ id, x, y });
  const upper = i => vertex(`U${wrap(i)}`, (i + 0.5) * side, height);
  const lower = i => vertex(`L${wrap(i)}`, i * side, 2 * height);
  for (let i = 0; i < 5; i++) {
    faces.push(
      { id: `north${i}`, vertices: [vertex("N", i * side, 0), upper(i - 1), upper(i)] },
      { id: `middleDown${i}`, vertices: [upper(i - 1), upper(i), lower(i)] },
      { id: `middleUp${i}`, vertices: [upper(i), lower(i), lower(i + 1)] },
      { id: `south${i}`, vertices: [lower(i), lower(i + 1), vertex("S", (i + 0.5) * side, 3 * height)] }
    );
  }
  for (const face of faces) {
    face.fragments = [];
    const lattice = new Map();
    for (let a = 0; a <= size; a++) {
      for (let b = 0; b <= size - a; b++) {
        const weights = [a, b, size - a - b];
        const support = face.vertices.map((v, index) => ({ id: v.id, weight: weights[index] }))
          .filter(v => v.weight > 0).sort((x, y) => x.id.localeCompare(y.id));
        // Endpoints and edge points use global vertex IDs. Interior points
        // belong to one face. Integer weights avoid floating-point seam keys.
        const id = support.length === 3 ? `${face.id}:${a}:${b}` :
          support.map(v => `${v.id}:${v.weight}`).join("/");
        if (!cells.has(id)) cells.set(id, { id, pentagon: support.length === 1, neighbors: new Set() });
        lattice.set(`${a},${b}`, id);
        const x = face.vertices.reduce((sum, v, k) => sum + v.x * weights[k] / size, 0);
        const y = face.vertices.reduce((sum, v, k) => sum + v.y * weights[k] / size, 0);
        face.fragments.push({ cellId: id, x, y });
      }
    }
    for (let a = 0; a <= size; a++) {
      for (let b = 0; b <= size - a; b++) {
        const id = lattice.get(`${a},${b}`);
        for (const [da, db] of [[1, 0], [0, 1], [1, -1]]) {
          const other = lattice.get(`${a + da},${b + db}`);
          if (other) { cells.get(id).neighbors.add(other); cells.get(other).neighbors.add(id); }
        }
      }
    }
  }
  return { size, spacing, side, height: 3 * height, width, faces, cells: [...cells.values()] };
}

export function renderWorldMapSvg(grid, worldName = "World") {
  if (!grid) throw new Error("A size-zero world has no globe surface map.");
  const { width, height, spacing } = grid;
  const margin = 16, header = 38, radius = spacing / SQRT3;
  const number = n => Number(n.toFixed(5));
  const points = vertices => vertices.map(v => `${number(v.x)},${number(v.y)}`).join(" ");
  const hex = (x, y) => points(Array.from({ length: 6 }, (_, i) => {
    const angle = Math.PI / 3 * i - Math.PI / 2;
    return { x: x + radius * Math.cos(angle), y: y + radius * Math.sin(angle) };
  }));
  const definitions = [], drawings = [];
  for (const face of grid.faces) {
    definitions.push(`<clipPath id="${face.id}" clipPathUnits="userSpaceOnUse"><polygon points="${points(face.vertices)}"/></clipPath>`);
    const polygons = face.fragments.map(f => `<polygon data-cell="${f.cellId}" points="${hex(f.x, f.y)}"/>`).join("");
    for (const offset of [-width, 0, width]) {
      const min = Math.min(...face.vertices.map(v => v.x)) + offset;
      const max = Math.max(...face.vertices.map(v => v.x)) + offset;
      if (max <= 0 || min >= width) continue;
      drawings.push(`<g transform="translate(${number(offset)} 0)"><g clip-path="url(#${face.id})" fill="white" stroke="#999" stroke-width="0.65">${polygons}</g><polygon points="${points(face.vertices)}" fill="none" stroke="#333" stroke-width="1.1"/></g>`);
    }
  }
  const label = `${worldName || "World"} — Size ${grid.size} — World hex: 1,000 km`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${number(width + 2 * margin)}" height="${number(height + header + 2 * margin)}" viewBox="0 0 ${number(width + 2 * margin)} ${number(height + header + 2 * margin)}">
  <title>${escapeXml(label)}</title><defs>${definitions.join("")}<clipPath id="mapBounds"><rect width="${number(width)}" height="${number(height)}"/></clipPath></defs>
  <rect width="100%" height="100%" fill="white"/>
  <text x="${margin}" y="24" font-family="sans-serif" font-size="${number(Math.min(12, width / (label.length * 0.7)))}">${escapeXml(label)}</text>
  <g transform="translate(${margin} ${header + margin})"><g clip-path="url(#mapBounds)">${drawings.join("")}</g><rect width="${number(width)}" height="${number(height)}" fill="none" stroke="#333" stroke-width="1"/></g></svg>`;
}
