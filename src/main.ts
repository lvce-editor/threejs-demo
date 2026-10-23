import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js'
import { Font } from 'three/addons/loaders/FontLoader.js'
import fontData from './helvetiker_regular.typeface.json'

const textColor = '#32b8ff'
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
const material = new THREE.MeshStandardMaterial({ color: textColor, metalness: 0.25, roughness: 0.35 })
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
