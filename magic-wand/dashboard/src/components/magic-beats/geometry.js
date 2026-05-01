import paper from "paper";
import { APPROACH_START_RADIUS, BEAT_LAYERS, BEAT_RADIUS } from "./constants";

export function evalBezier(b, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * b.from.x + 3 * mt * mt * t * b.cp1.x + 3 * mt * t * t * b.cp2.x + t * t * t * b.to.x,
    y: mt * mt * mt * b.from.y + 3 * mt * mt * t * b.cp1.y + 3 * mt * t * t * b.cp2.y + t * t * t * b.to.y,
  };
}

function createHeartPath(cx, cy, r) {
  const w = r * 1.15;
  const h = r * 1.2;
  const path = new paper.Path();
  path.moveTo(cx, cy + h * 0.5);
  path.cubicCurveTo(
    new paper.Point(cx - w * 0.1, cy + h * 0.1),
    new paper.Point(cx - w, cy - h * 0.05),
    new paper.Point(cx - w * 0.65, cy - h * 0.35),
  );
  path.cubicCurveTo(
    new paper.Point(cx - w * 0.3, cy - h * 0.85),
    new paper.Point(cx + w * 0.2, cy - h * 0.7),
    new paper.Point(cx, cy - h * 0.15),
  );
  path.cubicCurveTo(
    new paper.Point(cx - w * 0.2, cy - h * 0.7),
    new paper.Point(cx + w * 0.3, cy - h * 0.85),
    new paper.Point(cx + w * 0.65, cy - h * 0.35),
  );
  path.cubicCurveTo(
    new paper.Point(cx + w, cy - h * 0.05),
    new paper.Point(cx + w * 0.1, cy + h * 0.1),
    new paper.Point(cx, cy + h * 0.5),
  );
  path.closed = true;
  return path;
}

function createShape(shapeType, cx, cy, r) {
  const center = new paper.Point(cx, cy);
  switch (shapeType) {
    case "circle":
      return new paper.Path.Circle({ center, radius: r });
    case "triangle":
      return new paper.Path.RegularPolygon({ center, sides: 3, radius: r });
    case "square":
      return new paper.Path.RegularPolygon({ center, sides: 4, radius: r });
    default:
      return createHeartPath(cx, cy, r);
  }
}

export function makeBeatGroup(cx, cy, shapeType) {
  const group = new paper.Group();

  for (const { scale, color } of BEAT_LAYERS) {
    const shape = createShape(shapeType, cx, cy, BEAT_RADIUS * scale);
    shape.fillColor = new paper.Color(color);
    shape.strokeColor = null;
    group.addChild(shape);
  }

  for (let i = 0; i < 4; i++) {
    const angle = (45 + i * 90) * (Math.PI / 180);
    const dist = BEAT_RADIUS * 1.45;
    const sparkle = new paper.Path.Star({
      center: new paper.Point(cx + Math.cos(angle) * dist, cy + Math.sin(angle) * dist),
      points: 4,
      radius1: 10,
      radius2: 20,
      fillColor: new paper.Color("#fff1dd"),
      strokeColor: null,
    });
    group.addChild(sparkle);
  }

  return group;
}

export function makeApproachGroup(cx, cy, shapeType) {
  const group = new paper.Group();

  const outer = createShape(shapeType, cx, cy, BEAT_RADIUS);
  outer.fillColor = null;
  outer.strokeColor = new paper.Color("#ffb43b");
  outer.strokeWidth = 3.5;
  group.addChild(outer);

  const inner = createShape(shapeType, cx, cy, BEAT_RADIUS * 0.82);
  inner.fillColor = null;
  inner.strokeColor = new paper.Color("#ff6a2d");
  inner.strokeWidth = 2;
  group.addChild(inner);

  const startScale = APPROACH_START_RADIUS / BEAT_RADIUS;
  group.scale(startScale, new paper.Point(cx, cy));

  return group;
}

export function svgStarPoints(cx, cy, r1, r2, rotDeg) {
  return Array.from({ length: 8 }, (_, i) => {
    const angle = (rotDeg + i * 45) * Math.PI / 180;
    const r = i % 2 === 0 ? r2 : r1;
    return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
  }).join(" ");
}

export function generateStarDots(cx, cy, R, r, dotsPerSegment) {
  const verts = Array.from({ length: 10 }, (_, i) => {
    const angle = (-90 + i * 36) * Math.PI / 180;
    const rad = i % 2 === 0 ? R : r;
    return { x: cx + rad * Math.cos(angle), y: cy + rad * Math.sin(angle) };
  });
  const dots = [];
  for (let seg = 0; seg < 10; seg++) {
    const from = verts[seg];
    const to = verts[(seg + 1) % 10];
    for (let j = 0; j < dotsPerSegment; j++) {
      const t = j / dotsPerSegment;
      dots.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
  }
  return dots;
}
