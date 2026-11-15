// The 3D model of the range: Three.js draws it, GSAP animates everything that moves.
import * as THREE from 'three';
import gsap from 'gsap';

// Three colours only: navy ground, white structure and allowed traffic, red for anything blocked.
export const COL = {
  navy: 0x00008b, white: 0xffffff, red: 0xff0000,
  pod: 0xffffff, tgt: 0x00008b, gate: 0xffffff, sw: 0xffffff, inst: 0x00008b, mgmt: 0x00008b,
  permit: 0xffffff, deny: 0xff0000, pkt: 0xffffff, link: 0x6666c4, bg: 0x00008b,
};

type V3 = [number, number, number];
export interface CamPreset { th: number; ph: number; r: number; t: V3 }
interface NodeRec { grp: THREE.Group; mats: THREE.Material[]; label?: THREE.Sprite }
interface Leg { c: THREE.Curve<THREE.Vector3>; rev?: boolean; d: number }
interface Flight { tl: gsap.core.Timeline; sprite: THREE.Sprite; resolve: () => void }

const polar = (deg: number, r: number, y = 0): V3 => [r * Math.cos((deg * Math.PI) / 180), y, r * Math.sin((deg * Math.PI) / 180)];

// Teams sit on the left arc; scoring, college and management on the right. The checkpoint is the centre.
export const POS: Record<string, V3> = {
  scoring: polar(-32, 9.5),
  college: polar(4, 10.2),
  management: polar(42, 9.5, -2.2),
};
for (let k = 1; k <= 4; k++) {
  const th = 225 - 30 * (k - 1);
  POS[`pod-${k}`] = polar(th - 6.5, 10.5);
  POS[`target-${k}`] = polar(th + 6.5, 10.5);
  POS[`island-${k}`] = polar(th, 10.5);
}
const nodeOf = (n: string) => (n.startsWith('institutional') ? 'college' : n);
const teamOf = (n: string) => /^(pod|target)-(\d)$/.exec(n)?.[2] ?? null;
const SHIELD_R = 2.6;

export class RangeScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  private cam = { theta: 0, phi: 0.7, r: 27, tx: 0, ty: 0, tz: 0 };
  private nodes: Record<string, NodeRec> = {};
  private curves: Record<string, THREE.QuadraticBezierCurve3> = {};
  private flights = new Set<Flight>();
  private flash = { v: 0 };
  private flashColor = new THREE.Color(COL.gate);
  private gateColor = new THREE.Color(COL.gate);
  private shieldMat!: THREE.MeshBasicMaterial;
  private rimMat!: THREE.LineBasicMaterial;
  private spin!: THREE.Mesh;
  private glow: THREE.Texture;
  private ringGeo = new THREE.RingGeometry(0.18, 0.3, 40);
  /** The model's own clock. Every scene animation runs on it, so pause() freezes the model and nothing else. */
  private clock = gsap.timeline().to({}, { duration: 1e7 });
  private now = () => this.clock.time();
  private resize: ResizeObserver;
  private render = () => this.frame();

  constructor(private canvas: HTMLCanvasElement, private host: HTMLElement, private reduced: boolean) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(COL.bg, 1);
    this.scene.fog = new THREE.Fog(COL.bg, 34, 76);
    this.scene.add(new THREE.HemisphereLight(0xffffff, COL.navy, 2.0));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(8, 18, 12);
    this.scene.add(sun);
    const grid = new THREE.GridHelper(70, 35, 0x4040b4, 0x2020a2);
    grid.position.y = -0.9;
    this.scene.add(grid);

    this.glow = this.makeGlow();
    this.buildTeams();
    this.buildCentre();
    this.buildRightSide();
    this.buildCables();
    this.bindDrag();

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    gsap.ticker.add(this.render);
  }

  dispose() {
    gsap.ticker.remove(this.render);
    this.resize.disconnect();
    this.clear();
    this.renderer.dispose();
  }

  // ---------- building the model ----------

  private mat(color: number) {
    const glow = color === COL.white ? 0.35 : 0.5;
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, emissive: color, emissiveIntensity: glow, transparent: true });
    m.userData.base = 1;
    return m;
  }

  /** A box with drawn edges: navy edges on white solids, white edges on navy (outlined) solids. */
  private box(w: number, h: number, d: number, color: number, y: number, edgeOpacity = 0.95): THREE.Object3D[] {
    const g = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(g, this.mat(color));
    mesh.position.y = y;
    const edgeColor = color === COL.white ? COL.navy : COL.white;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: edgeOpacity }));
    edges.material.userData.base = edgeOpacity;
    edges.position.y = y;
    return [mesh, edges];
  }

  private circle(radius: number, y: number, segments = 72) {
    return new THREE.Path().absarc(0, 0, radius, 0, Math.PI * 2, false).getPoints(segments).map(p => new THREE.Vector3(p.x, y, p.y));
  }

  private addNode(name: string, grp: THREE.Group, at: V3, label?: THREE.Sprite, labelY = 2.6) {
    grp.position.set(...at);
    this.scene.add(grp);
    const mats: THREE.Material[] = [];
    grp.traverse(o => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) {
        if (m.userData.base === undefined) m.userData.base = m.opacity;
        mats.push(m);
      }
    });
    if (label) {
      label.position.set(at[0], labelY, at[2]);
      this.scene.add(label);
    }
    this.nodes[name] = { grp, mats, label };
  }

  private buildTeams() {
    for (let k = 1; k <= 4; k++) {
      const island = new THREE.Group();
      const plat = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 2.7, 0.12, 48), this.mat(0x10109c));
      plat.position.y = -0.86;
      island.add(plat);
      island.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(this.circle(2.7, -0.79)), new THREE.LineBasicMaterial({ color: COL.white, transparent: true, opacity: 0.55 })));
      this.addNode(`island-${k}`, island, POS[`island-${k}`], this.makeLabel(`Team ${k}`, `VLAN ${100 + k} and ${200 + k}`), 2.9);

      const pod = new THREE.Group();
      this.box(1.5, 1.1, 1.5, COL.pod, -0.25).forEach(o => pod.add(o));
      this.addNode(`pod-${k}`, pod, POS[`pod-${k}`]);

      const tgt = new THREE.Group();
      [-0.62, -0.24, 0.14].forEach(y => this.box(1.4, 0.3, 1.4, COL.tgt, y).forEach(o => tgt.add(o)));
      this.addNode(`target-${k}`, tgt, POS[`target-${k}`]);
    }
  }

  private buildCentre() {
    const sw = new THREE.Group();
    this.box(3.4, 0.9, 2.2, COL.sw, -0.4).forEach(o => sw.add(o));
    for (let i = 0; i < 8; i++) {
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.05), new THREE.MeshBasicMaterial({ color: COL.navy, transparent: true }));
      led.position.set(-1.3 + i * 0.37, -0.35, 1.11);
      sw.add(led);
      this.clock.to(led.material, { opacity: 0.25, duration: 0.5 + (i % 3) * 0.3, repeat: -1, yoyo: true, ease: 'sine.inOut' }, this.now() + i * 0.12);
    }
    this.shieldMat = new THREE.MeshBasicMaterial({ color: COL.gate, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false });
    const shield = new THREE.Mesh(new THREE.CylinderGeometry(SHIELD_R, SHIELD_R, 2.6, 64, 1, true), this.shieldMat);
    shield.position.y = 0.3;
    sw.add(shield);
    this.rimMat = new THREE.LineBasicMaterial({ color: COL.gate, transparent: true, opacity: 0.85 });
    sw.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(this.circle(SHIELD_R, 1.6, 80)), this.rimMat));
    this.addNode('switch', sw, [0, 0, 0], this.makeLabel('Checkpoint switch', 'SW-DIST-EXER'), 3.1);
  }

  private buildRightSide() {
    const sc = new THREE.Group();
    this.spin = new THREE.Mesh(new THREE.OctahedronGeometry(1.0), this.mat(COL.gate));
    this.spin.position.y = 0.5;
    sc.add(this.spin);
    this.box(1.6, 0.3, 1.6, COL.navy, -0.75).forEach(o => sc.add(o));
    this.addNode('scoring', sc, POS.scoring, this.makeLabel('Scoring server', '10.10.30.0/24'));
    this.clock.to(this.spin.rotation, { y: Math.PI * 2, duration: 8, repeat: -1, ease: 'none' }, this.now());
    this.clock.to(this.spin.position, { y: 0.75, duration: 1.6, repeat: -1, yoyo: true, ease: 'sine.inOut' }, this.now());

    const college = new THREE.Group();
    this.box(1.8, 2.2, 1.6, COL.inst, 0.2).forEach(o => college.add(o));
    this.box(1.2, 1.2, 1.2, COL.inst, -0.3).forEach(o => { o.position.x = 1.4; college.add(o); });
    this.addNode('college', college, POS.college, this.makeLabel('College network', '10.10.0.0/16'), 2.9);

    const mg = new THREE.Group();
    this.box(2.0, 0.6, 1.4, COL.mgmt, 0).forEach(o => mg.add(o));
    const moat = new THREE.Line(new THREE.BufferGeometry().setFromPoints(this.circle(2.2, -0.35, 80)), new THREE.LineDashedMaterial({ color: COL.red, dashSize: 0.35, gapSize: 0.25, transparent: true }));
    moat.computeLineDistances();
    mg.add(moat);
    this.addNode('management', mg, POS.management, this.makeLabel('Management network', 'no cable to the range'), -0.3);
  }

  private curveFor(p: V3) {
    const start = new THREE.Vector3(p[0], 0.3, p[2]);
    const end = new THREE.Vector3(p[0], 0, p[2]).normalize().multiplyScalar(SHIELD_R);
    end.y = 0.3;
    const mid = start.clone().add(end).multiplyScalar(0.5);
    mid.y = 2.6;
    return new THREE.QuadraticBezierCurve3(start, mid, end);
  }

  private buildCables() {
    for (const n of ['pod-1', 'pod-2', 'pod-3', 'pod-4', 'target-1', 'target-2', 'target-3', 'target-4', 'scoring']) {
      this.curves[n] = this.curveFor(POS[n]);
      this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(this.curves[n].getPoints(48)), new THREE.LineBasicMaterial({ color: COL.link })));
    }
    this.curves.college = this.curveFor(POS.college);
    const dashed = new THREE.Line(new THREE.BufferGeometry().setFromPoints(this.curves.college.getPoints(48)), new THREE.LineDashedMaterial({ color: COL.link, dashSize: 0.4, gapSize: 0.3 }));
    dashed.computeLineDistances();
    this.scene.add(dashed);
    this.curves['institutional-a'] = this.curves['institutional-b'] = this.curves.college;
  }

  private makeGlow() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  private makeLabel(text: string, sub?: string) {
    const W = 680;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = sub ? 170 : 110;
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const big = '800 52px "SN Pro", "Segoe UI", sans-serif';
    const small = '500 30px "SN Pro", "Segoe UI", sans-serif';
    g.font = big;
    let w = g.measureText(text).width;
    if (sub) { g.font = small; w = Math.max(w, g.measureText(sub).width); }
    w = Math.min(W - 12, w + 48);
    const x0 = (W - w) / 2, h = c.height - 10;
    g.fillStyle = 'rgba(0, 0, 139, 0.94)';
    g.fillRect(x0, 5, w, h);
    g.strokeStyle = '#FFFFFF';
    g.lineWidth = 4;
    g.strokeRect(x0, 5, w, h);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = big; g.fillStyle = '#FFFFFF'; g.fillText(text, W / 2, sub ? 58 : 56);
    if (sub) { g.font = small; g.fillStyle = 'rgba(255, 255, 255, 0.78)'; g.fillText(sub, W / 2, 122); }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    s.renderOrder = 10;
    s.scale.set(5.4, (5.4 * c.height) / W, 1);
    return s;
  }

  // ---------- camera ----------

  private bindDrag() {
    let drag: { x: number; y: number; touch: boolean } | null = null;
    this.canvas.addEventListener('pointerdown', e => {
      drag = { x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' };
      gsap.killTweensOf(this.cam);
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      this.cam.theta -= (e.clientX - drag.x) * 0.006;
      if (!drag.touch) this.cam.phi = Math.min(1.35, Math.max(0.18, this.cam.phi + (e.clientY - drag.y) * 0.004));
      drag.x = e.clientX;
      drag.y = e.clientY;
    });
    const end = () => { drag = null; };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  private fit() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  camTo(p: CamPreset) {
    const to = { theta: (p.th * Math.PI) / 180, phi: (p.ph * Math.PI) / 180, r: p.r, tx: p.t[0], ty: p.t[1], tz: p.t[2] };
    if (this.reduced) Object.assign(this.cam, to);
    else this.clock.to(this.cam, { ...to, duration: 1.4, ease: 'power3.inOut', overwrite: true }, this.now());
  }

  private frame() {
    // Narrow or portrait screens pull the camera back so all four teams and the right side stay in frame.
    const k = Math.max(1, 1.35 / this.camera.aspect);
    const { theta, phi, tx, ty, tz } = this.cam, r = this.cam.r * k;
    this.camera.position.set(tx + r * Math.cos(phi) * Math.sin(theta), ty + r * Math.sin(phi), tz + r * Math.cos(phi) * Math.cos(theta));
    this.camera.lookAt(tx, ty, tz);
    this.shieldMat.color.copy(this.gateColor).lerp(this.flashColor, this.flash.v);
    this.shieldMat.opacity = 0.1 + 0.32 * this.flash.v;
    this.rimMat.color.copy(this.shieldMat.color);
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- effects ----------

  focus(list: string[] | null) {
    const lit = (n: string) => {
      if (!list || n === 'switch') return true;
      if (n.startsWith('island-')) return list.some(x => teamOf(x) === n.slice(7));
      return list.some(x => nodeOf(x) === n);
    };
    for (const [n, node] of Object.entries(this.nodes)) {
      const on = lit(n);
      node.mats.forEach(m => gsap.to(m, { opacity: on ? m.userData.base : 0.16, duration: 0.6, overwrite: true }));
      if (node.label) gsap.to(node.label.material, { opacity: on ? 1 : 0.25, duration: 0.6, overwrite: true });
    }
  }

  pulse(name: string) {
    const n = this.nodes[nodeOf(name)];
    if (!n) return;
    this.clock.fromTo(n.grp.scale, { x: 1, y: 1, z: 1 }, { x: 1.22, y: 1.22, z: 1.22, duration: 0.22, yoyo: true, repeat: 1, ease: 'power2.out', overwrite: true }, this.now());
  }

  flashShield(color: number) {
    this.flashColor.setHex(color);
    this.clock.fromTo(this.flash, { v: 1 }, { v: 0, duration: 0.45, ease: 'power2.out', overwrite: true }, this.now());
  }

  /** A ring that spreads from where a packet ends. Fast sweeps get small, faint rings so hundreds of them stay readable. */
  private burst(pos: THREE.Vector3, color: number, speed = 1) {
    const fast = speed > 1;
    const mesh = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fast ? 0.45 : 0.95, side: THREE.DoubleSide, depthWrite: false }));
    mesh.position.copy(pos);
    mesh.lookAt(this.camera.position);
    this.scene.add(mesh);
    const size = fast ? 2.6 : 8;
    this.clock.to(mesh.scale, { x: size, y: size, z: size, duration: fast ? 0.4 : 0.6, ease: 'power2.out' }, this.now());
    this.clock.to(mesh.material, {
      opacity: 0, duration: fast ? 0.4 : 0.6, ease: 'power1.in',
      onComplete: () => { this.scene.remove(mesh); mesh.material.dispose(); },
    }, this.now());
  }

  // ---------- packets ----------

  /** Fly one packet. A blocked packet stops at the checkpoint shield; an allowed one crosses to the receiver. */
  send(src: string, dst: string, permit: boolean, speed = 1): Promise<void> {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    let legs: Leg[];
    if (src === dst) {
      const p = POS[src], off = (Math.random() - 0.5) * 2.4;
      legs = [{ c: new THREE.QuadraticBezierCurve3(V(p[0], 0.4, p[2]), V(p[0] + off, 3.4, p[2] - off), V(p[0], 0.4, p[2])), d: 0.9 }];
    } else if (permit) {
      const a = this.curves[src].v2, b = this.curves[dst].v2;
      legs = [{ c: this.curves[src], d: 0.9 }, { c: new THREE.QuadraticBezierCurve3(a, V(0, 1.3, 0), b), d: 0.35 }, { c: this.curves[dst], rev: true, d: 0.9 }];
    } else {
      legs = [{ c: this.curves[src], d: 0.9 }];
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glow, color: src === dst ? COL.permit : COL.pkt,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    sprite.scale.set(0.95, 0.95, 1);
    sprite.position.copy(legs[0].c.getPoint(0));
    this.scene.add(sprite);

    return new Promise(resolve => {
      const tl = gsap.timeline();
      const flight: Flight = { tl, sprite, resolve };
      legs.forEach((leg, i) => {
        const st = { t: 0 };
        if (i === 1) tl.call(() => { sprite.material.color.setHex(COL.permit); this.flashShield(COL.permit); });
        tl.to(st, {
          t: 1, duration: leg.d / speed, ease: i === 0 ? 'power1.in' : i === legs.length - 1 ? 'power1.out' : 'none',
          onUpdate: () => { sprite.position.copy(leg.c.getPoint(leg.rev ? 1 - st.t : st.t)); },
        });
      });
      tl.call(() => {
        if (permit) { this.burst(sprite.position.clone(), COL.permit, speed); this.pulse(dst); }
        else { this.burst(sprite.position.clone(), COL.deny, speed); this.flashShield(COL.deny); }
        this.drop(flight);
      });
      this.clock.add(tl, this.now());
      this.flights.add(flight);
    });
  }

  private drop(f: Flight) {
    f.tl.kill();
    this.scene.remove(f.sprite);
    f.sprite.material.dispose();
    this.flights.delete(f);
    f.resolve();
  }

  /** Freeze the model where it is. Dragging still turns it. */
  pause() { this.clock.pause(); }

  resume() { this.clock.resume(); }

  /** Remove every packet in flight; their promises resolve so waiting steps can stop. */
  clear() {
    for (const f of [...this.flights]) this.drop(f);
  }
}
