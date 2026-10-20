/** Local joint angles in degrees. Positive is clockwise, matching Phaser. */
export const CHARACTER_POSES = {
  idle: { leftArm: -8, rightArm: 8, head: 0, eyesX: 0, eyesY: 0, rise: 0 },
  greet: { leftArm: -96, rightArm: 6, head: -6, eyesX: 0, eyesY: 0, rise: 0 },
  think: { leftArm: 14, rightArm: -62, head: 16, eyesX: 4, eyesY: 2, rise: 0 },
  celebrate: { leftArm: -150, rightArm: 150, head: -10, eyesX: 0, eyesY: -2, rise: 10 },
} as const;

export type PoseName = keyof typeof CHARACTER_POSES;

export function poseSignature(name: PoseName) {
  const pose = CHARACTER_POSES[name];
  return `${pose.leftArm}|${pose.rightArm}|${pose.head}|${pose.eyesX}|${pose.eyesY}|${pose.rise}`;
}
