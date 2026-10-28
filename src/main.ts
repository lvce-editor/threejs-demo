import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js'
import { Font } from 'three/addons/loaders/FontLoader.js'
import fontData from './helvetiker_regular.typeface.json'

const textColor = '#32b8ff'
const runtime = globalThis as typeof globalThis & { __threejsDemoMatcapTextures?: THREE.CanvasTexture<OffscreenCanvas>[] }
const matcapTexture = ((): THREE.CanvasTexture<OffscreenCanvas> => {
  if (runtime.__threejsDemoMatcapTextures) return runtime.__threejsDemoMatcapTextures[0]
  const canvas = new OffscreenCanvas(256, 256)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  runtime.__threejsDemoMatcapTextures = [texture]
  return texture
})()
const matcapCycleInterval = 7000
const matcapUpdateInterval = 50
const matcapPalettes = [
  { accent: '#31baff', flare: '#ffffff', midtone: '#18344b', reflection: '#b8f3ff', shadow: '#020812' },
  { accent: '#72b7ff', flare: '#ffffff', midtone: '#392342', reflection: '#b8fff0', shadow: '#090614' },
  { accent: '#e78145', flare: '#fffdf5', midtone: '#563c20', reflection: '#ffe0a6', shadow: '#100b08' },
]
const matcapContext = matcapTexture.image.getContext('2d')!
const updateMatcap = (time: number, index: number): void => {
  const palette = matcapPalettes[index]
  const phase = time * 0.00045 + index * 1.7
  const gradient = matcapContext.createRadialGradient(110, 84, 8, 132, 144, 188)
  gradient.addColorStop(0, palette.midtone)
  gradient.addColorStop(0.48, '#101722')
  gradient.addColorStop(1, palette.shadow)
  matcapContext.fillStyle = gradient
  matcapContext.fillRect(0, 0, 256, 256)

  for (let band = -1; band < 5; band++) {
    const y = band * 68 + Math.sin(phase + band * 1.3) * 28
    const drift = Math.cos(phase * 0.8 + band) * 36
    const ribbon = matcapContext.createLinearGradient(0, y - 24, 256, y + 30)
    ribbon.addColorStop(0, `${palette.shadow}00`)
    ribbon.addColorStop(0.28, `${palette.accent}bb`)
    ribbon.addColorStop(0.48, `${palette.flare}ee`)
    ribbon.addColorStop(0.54, `${palette.reflection}ff`)
    ribbon.addColorStop(0.67, `${palette.accent}99`)
    ribbon.addColorStop(1, `${palette.shadow}00`)
    matcapContext.beginPath()
    // eslint-disable-next-line unicorn/prefer-path2d -- the curve coordinates change each texture frame
    matcapContext.moveTo(-32, y + drift)
    matcapContext.bezierCurveTo(40, y - 64 + drift, 92, y + 66 - drift, 154, y - 4)
    matcapContext.bezierCurveTo(196, y - 54 + drift, 218, y + 42, 288, y - 22 - drift)
    matcapContext.lineWidth = 25
    matcapContext.lineCap = 'round'
    matcapContext.strokeStyle = ribbon
    matcapContext.stroke()

    matcapContext.beginPath()
    // eslint-disable-next-line unicorn/prefer-path2d -- the curve coordinates change each texture frame
    matcapContext.moveTo(-20, y - 11 + drift)
    matcapContext.bezierCurveTo(40, y - 72 + drift, 112, y + 41 - drift, 160, y - 14)
    matcapContext.bezierCurveTo(210, y - 57 + drift, 232, y + 15, 276, y - 33 - drift)
    matcapContext.lineWidth = 2
    matcapContext.strokeStyle = `${palette.flare}dd`
    matcapContext.stroke()
  }

  matcapTexture.needsUpdate = true
}
updateMatcap(0, 0)
const canvas = document.querySelector<HTMLCanvasElement>('#scene')!
const renderer = new THREE.WebGLRenderer({ antialias: true, canvas })
renderer.setSize(640, 480)

const scene = new THREE.Scene()
scene.background = new THREE.Color('#111827')
const camera = new THREE.PerspectiveCamera(45, 640 / 480, 0.1, 100)
camera.position.z = 5
const controls = new OrbitControls(camera, canvas)

const font = new Font(fontData)
const geometry = new TextGeometry('LVCE', {
  bevelEnabled: true,
  bevelSegments: 2,
  bevelSize: 0.015,
  bevelThickness: 0.025,
  curveSegments: 8,
  depth: 0.18,
  font,
  size: 0.8,
})
geometry.computeBoundingBox()
geometry.center()
const material = new THREE.MeshMatcapMaterial({ color: textColor, matcap: matcapTexture })
const text = new THREE.Mesh(geometry, material)
text.rotation.x = -0.12
scene.add(new THREE.HemisphereLight(0xff_ff_ff, 0x33_41_55, 2))
const keyLight = new THREE.DirectionalLight(0xff_ff_ff, 3)
keyLight.position.set(-2, 3, 5)
scene.add(keyLight, text)

const animationState: { lastMatcapIndex: number; lastMatcapUpdate?: number; startedAt?: number } = { lastMatcapIndex: 0 }
const animate = (time: number): void => {
  animationState.startedAt ??= time
  controls.update()
  text.rotation.y += 0.003
  const matcapIndex = Math.floor((time - animationState.startedAt) / matcapCycleInterval) % matcapPalettes.length
  if (matcapIndex !== animationState.lastMatcapIndex) {
    animationState.lastMatcapIndex = matcapIndex
  }
  if (animationState.lastMatcapUpdate === undefined || time - animationState.lastMatcapUpdate >= matcapUpdateInterval) {
    updateMatcap(time, matcapIndex)
    animationState.lastMatcapUpdate = time
  }
  renderer.render(scene, camera)
  requestAnimationFrame(animate)
}
requestAnimationFrame(animate)
