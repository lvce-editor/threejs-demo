import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const cubeColor = '#32b8ff'
const canvas = document.querySelector<HTMLCanvasElement>('#scene')!
const renderer = new THREE.WebGLRenderer({ antialias: true, canvas })
renderer.setSize(640, 480)

const scene = new THREE.Scene()
scene.background = new THREE.Color('#111827')
const camera = new THREE.PerspectiveCamera(45, 640 / 480, 0.1, 100)
camera.position.z = 3
const controls = new OrbitControls(camera, canvas)

const geometry = new THREE.BoxGeometry(1, 1, 1)
const material = new THREE.MeshBasicMaterial({ color: cubeColor })
const cube = new THREE.Mesh(geometry, material)
cube.rotation.set(0.4, 0.7, 0)
scene.add(cube)

const animate = (): void => {
  controls.update()
  cube.rotation.y += 0.01
  renderer.render(scene, camera)
  requestAnimationFrame(animate)
}
animate()
