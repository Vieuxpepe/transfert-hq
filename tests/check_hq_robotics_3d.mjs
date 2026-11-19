// Robotique 3D module checks. Without an argument: inverse kinematics round trips and the overlap test.
// With a JSON file: print the poses the browser generates for each case so that
// tests/test_hq_robotics_editor.py can compare them with the server's own expansion.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

globalThis.window = { matchMedia: () => ({ matches: false }), devicePixelRatio: 1 };
globalThis.document = { body: { classList: { contains: () => false } } };
vm.runInThisContext(readFileSync(new URL('../assets/hq-robotics-3d.js', import.meta.url), 'utf8'));
const R = window.HqRobotics3D;

if (process.argv[2]) {
  const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const out = {};
  for (const [name, c] of Object.entries(cases)) {
    out[name] = R.planPath([c.start, ...c.points], [null, ...c.legs]).poses;
  }
  console.log(JSON.stringify(out));
} else {
  const same = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, message + `: ${a} vs ${b}`);
  for (const pose of [{ base: 25, shoulder: -10, elbow: 70, hand: 150 }, { base: -60, shoulder: 30, elbow: 40, hand: 90 },
    { base: 0, shoulder: 0, elbow: 90, hand: 180 }]) {
    const tip = R.links(pose).tcp;
    const back = R.ik(tip[0], tip[1], tip[2], pose.hand);
    for (const key of ['base', 'shoulder', 'elbow', 'hand']) same(back[key], pose[key], 'ik round trip ' + key);
  }
  assert.equal(R.ik(2000, 0, 0, 180), null, 'out of reach');
  const neutral = { base: 0, shoulder: 0, elbow: 90, hand: 180 };
  const tip = R.links(neutral).tcp;
  const around = d => ({ x: [tip[0] - d, tip[0] + d], y: [-d, d], z: [tip[2] - d, tip[2] + d] });
  assert.ok(R.touches(neutral, around(5)), 'a box on the gripper touches');
  assert.ok(R.touches(neutral, { x: [tip[0] - 5, tip[0] + 5], y: [30, 40], z: [tip[2] - 5, tip[2] + 5] }),
    'a box 30 mm beside the gripper touches the 34 mm gripper');
  assert.ok(!R.touches(neutral, { x: [tip[0] - 5, tip[0] + 5], y: [200, 210], z: [tip[2] - 5, tip[2] + 5] }), 'a far box does not');
  // The nearest corner an allowed box can have (x 45, z 25) lies 51.5 mm from the shoulder axis: outside its 50 mm.
  assert.ok(!R.touches(neutral, { x: [45, 60], y: [-10, 10], z: [25, 40] }), 'the closest allowed box clears the shoulder');
  assert.ok(R.touches(neutral, { x: [20, 60], y: [-10, 10], z: [100, 140] }), 'a box beside the upper arm touches');
  const cl = R.closestClearance(neutral, [{ name: 'Bac', x: [tip[0] - 5, tip[0] + 5], y: [80, 140], z: [tip[2] - 5, tip[2] + 5] }]);
  assert.ok(cl && cl.zoneName === 'Bac' && cl.part === 'Pince', 'closestClearance identifies the nearest zone and arm link');
  same(cl.gap, 80 - 34, 'closestClearance gap from 34 mm gripper radius at y=0 to box y=80');
  assert.equal(R.closestClearance(neutral, []), null, 'empty keepout returns null clearance');
  console.log('check_hq_robotics_3d: OK');
}
