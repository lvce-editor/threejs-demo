import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js'
import { Font } from 'three/addons/loaders/FontLoader.js'
import fontData from './helvetiker_regular.typeface.json'

const textColor = '#32b8ff'
const runtime = globalThis as typeof globalThis & { __threejsDemoMatcapTextures?: THREE.CanvasTexture<OffscreenCanvas>[] }
const matcapTextures = ((): THREE.CanvasTexture<OffscreenCanvas>[] => {
  if (runtime.__threejsDemoMatcapTextures) return runtime.__threejsDemoMatcapTextures
  const palettes = [
    ['#ffffff', '#e7faff', '#56d8ff', '#1879c7', '#092b62', '#020817'],
    ['#ffffff', '#fff4db', '#ffb347', '#cb5a35', '#632d64', '#100d28'],
    ['#ffffff', '#e7fff5', '#55e6b1', '#188e87', '#164b69', '#071929'],
  ]
  const textures = palettes.map((palette, index) => {
    const matcapCanvas = new OffscreenCanvas(256, 256)
    const matcapContext = matcapCanvas.getContext('2d')!
    const matcapGradient = matcapContext.createRadialGradient(120, 116, 4, 128, 128, 180)
    for (const [stop, color] of palette.entries()) matcapGradient.addColorStop([0, 0.12, 0.3, 0.62, 0.86, 1][stop], color)
    matcapContext.fillStyle = matcapGradient
    matcapContext.fillRect(0, 0, 256, 256)
    matcapContext.fillStyle = 'rgba(255, 255, 255, 0.88)'
    matcapContext.beginPath()
    matcapContext.ellipse(104 + index * 5, 102 - index * 3, 25, 13, -0.65, 0, Math.PI * 2)
    matcapContext.fill()
    const texture = new THREE.CanvasTexture(matcapCanvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    return texture
  })
  runtime.__threejsDemoMatcapTextures = textures
  return textures
})()
const matcapCycleInterval = 7000
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
const material = new THREE.MeshMatcapMaterial({ color: textColor, matcap: matcapTextures[0] })
const text = new THREE.Mesh(geometry, material)
text.rotation.x = -0.12
scene.add(new THREE.HemisphereLight(0xff_ff_ff, 0x33_41_55, 2))
const keyLight = new THREE.DirectionalLight(0xff_ff_ff, 3)
keyLight.position.set(-2, 3, 5)
scene.add(keyLight, text)

const animationState: { lastMatcapIndex: number; startedAt?: number } = { lastMatcapIndex: 0 }
const animate = (time: number): void => {
  animationState.startedAt ??= time
  controls.update()
  text.rotation.y += 0.003
  const matcapIndex = Math.floor((time - animationState.startedAt) / matcapCycleInterval) % matcapTextures.length
  if (matcapIndex !== animationState.lastMatcapIndex) {
    material.matcap = matcapTextures[matcapIndex]
    animationState.lastMatcapIndex = matcapIndex
  }
  renderer.render(scene, camera)
  requestAnimationFrame(animate)
}
requestAnimationFrame(animate)
