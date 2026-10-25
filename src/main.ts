import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js'
import { Font } from 'three/addons/loaders/FontLoader.js'
import fontData from './helvetiker_regular.typeface.json'

const textColor = '#32b8ff'
const matcapCanvas = document.createElement('canvas')
matcapCanvas.width = 256
matcapCanvas.height = 256
const matcapContext = matcapCanvas.getContext('2d')!
const matcapGradient = matcapContext.createRadialGradient(82, 68, 8, 128, 128, 180)
matcapGradient.addColorStop(0, '#ffffff')
matcapGradient.addColorStop(0.12, '#e7faff')
matcapGradient.addColorStop(0.3, '#56d8ff')
matcapGradient.addColorStop(0.62, '#1879c7')
matcapGradient.addColorStop(0.86, '#092b62')
matcapGradient.addColorStop(1, '#020817')
matcapContext.fillStyle = matcapGradient
matcapContext.fillRect(0, 0, matcapCanvas.width, matcapCanvas.height)
matcapContext.fillStyle = 'rgba(255, 255, 255, 0.88)'
matcapContext.beginPath()
matcapContext.ellipse(78, 64, 25, 13, -0.65, 0, Math.PI * 2)
matcapContext.fill()
const matcapTexture = new THREE.CanvasTexture(matcapCanvas)
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

const animate = (): void => {
  controls.update()
  text.rotation.y += 0.003
  renderer.render(scene, camera)
  requestAnimationFrame(animate)
}
animate()
