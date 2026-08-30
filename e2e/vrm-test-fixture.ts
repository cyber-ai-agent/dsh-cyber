export function interactiveVrmFixture(): Buffer {
  const positions = new Float32Array([
    -0.3, 0, -0.15, 0.3, 0, -0.15, 0.3, 1.8, -0.15, -0.3, 1.8, -0.15,
    -0.3, 0, 0.15, 0.3, 0, 0.15, 0.3, 1.8, 0.15, -0.3, 1.8, 0.15,
  ])
  const morph = new Float32Array(positions.length)
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7,
    0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ])
  const positionBytes = Buffer.from(positions.buffer)
  const morphBytes = Buffer.from(morph.buffer)
  const indexBytes = Buffer.from(indices.buffer)
  const binary = Buffer.concat([positionBytes, morphBytes, indexBytes])
  const bones = [
    ['hips', [0, 0.9, 0]], ['spine', [0, 0.25, 0]], ['head', [0, 0.55, 0]],
    ['leftUpperLeg', [-0.16, -0.25, 0]], ['leftLowerLeg', [0, -0.42, 0]], ['leftFoot', [0, -0.42, 0.05]],
    ['rightUpperLeg', [0.16, -0.25, 0]], ['rightLowerLeg', [0, -0.42, 0]], ['rightFoot', [0, -0.42, 0.05]],
    ['leftUpperArm', [-0.28, 0.35, 0]], ['leftLowerArm', [-0.35, 0, 0]], ['leftHand', [-0.3, 0, 0]],
    ['rightUpperArm', [0.28, 0.35, 0]], ['rightLowerArm', [0.35, 0, 0]], ['rightHand', [0.3, 0, 0]],
  ] as const
  const nodes: Array<Record<string, unknown>> = bones.map(([name, translation]) => ({ name, translation }))
  nodes[0]!.children = [1, 3, 6, 9, 12, 15]
  nodes[1]!.children = [2]
  nodes[3]!.children = [4]; nodes[4]!.children = [5]
  nodes[6]!.children = [7]; nodes[7]!.children = [8]
  nodes[9]!.children = [10]; nodes[10]!.children = [11]
  nodes[12]!.children = [13]; nodes[13]!.children = [14]
  nodes.push({ name: 'bodyMesh', mesh: 0 })
  const humanBones = Object.fromEntries(bones.map(([name], node) => [name, { node }]))
  const expressions = Object.fromEntries(['aa', 'ih', 'ou', 'ee', 'oh'].map((name) => [name, { morphTargetBinds: [{ node: 15, index: 0, weight: 1 }] }]))
  const document = {
    asset: { version: '2.0', generator: 'DSH Cyber E2E fixture' },
    extensionsUsed: ['VRMC_vrm'],
    extensions: { VRMC_vrm: {
      specVersion: '1.0',
      meta: { name: 'DSH E2E Avatar', version: '1', authors: ['DSH Cyber'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlyAuthor', commercialUsage: 'personalNonProfit', creditNotation: 'unnecessary', modification: 'allowModification', allowRedistribution: false },
      humanoid: { humanBones }, expressions: { preset: expressions }, lookAt: { type: 'bone' },
    } },
    scene: 0, scenes: [{ nodes: [0] }], nodes,
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length, byteLength: morphBytes.length, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length + morphBytes.length, byteLength: indexBytes.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.3, 0, -0.15], max: [0.3, 1.8, 0.15] },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 0] },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.12, 0.48, 0.68, 1], metallicFactor: 0.15, roughnessFactor: 0.7 }, doubleSided: true }],
    meshes: [{ weights: [0], primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, targets: [{ POSITION: 2 }] }] }],
  }
  return glb(document, binary)
}

function glb(document: unknown, binary: Buffer): Buffer {
  const rawJson = Buffer.from(JSON.stringify(document), 'utf8')
  const json = Buffer.concat([rawJson, Buffer.alloc((4 - rawJson.length % 4) % 4, 0x20)])
  const bin = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)])
  const output = Buffer.alloc(12 + 8 + json.length + 8 + bin.length)
  output.write('glTF', 0, 'ascii'); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8)
  output.writeUInt32LE(json.length, 12); output.writeUInt32LE(0x4e4f534a, 16); json.copy(output, 20)
  const binHeader = 20 + json.length
  output.writeUInt32LE(bin.length, binHeader); output.writeUInt32LE(0x004e4942, binHeader + 4); bin.copy(output, binHeader + 8)
  return output
}
