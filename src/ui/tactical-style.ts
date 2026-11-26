import * as THREE from 'three';
import { Text } from 'troika-three-text';

export const TACTICAL_PLATE = {
  frame: 0x438592,
  backing: 0x071823,
  inset: 0x153644,
  trim: 0x53e4f2,
} as const;

export function createChamferPlate(
  width: number,
  height: number,
  bevel: number,
): THREE.ShapeGeometry {
  const x = width / 2;
  const y = height / 2;
  const outline = new THREE.Shape();
  outline.moveTo(-x + bevel, y);
  outline.lineTo(x - bevel, y);
  outline.lineTo(x, y - bevel);
  outline.lineTo(x, -y + bevel);
  outline.lineTo(x - bevel, -y);
  outline.lineTo(-x + bevel, -y);
  outline.lineTo(-x, -y + bevel);
  outline.lineTo(-x, y - bevel);
  outline.closePath();
  return new THREE.ShapeGeometry(outline);
}

export function createBatchedTextMember(
  text: string,
  fontUrl: string,
  fontSize: number,
  color: string,
  x: number,
  y: number,
  anchorX: 'left' | 'center' | 'right',
): Text {
  const member = new Text();
  member.text = text;
  member.font = fontUrl;
  member.fontSize = fontSize;
  member.color = color;
  member.anchorX = anchorX;
  member.anchorY = 'middle';
  member.position.set(x, y, 0.004);
  member.updateMatrix();
  member.sync();
  return member;
}
