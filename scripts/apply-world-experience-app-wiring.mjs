import { readFile, writeFile } from 'node:fs/promises'

const path = 'packages/web/src/App.tsx'
let source = await readFile(path, 'utf8')
const replace = (from, to) => {
  if (!source.includes(from)) throw new Error(`Missing App.tsx anchor: ${from.slice(0, 120)}`)
  source = source.replace(from, to)
}

replace(
  "appearance: { ...(previous?.appearance ?? {}), avatarIndex: input.avatarIndex },",
  "appearance: { ...(previous?.appearance ?? {}), avatarIndex: input.avatarIndex, worldSkinIndex: input.avatarIndex },",
)
replace(
  "appearance: { ...(previous?.appearance ?? {}), avatarIndex: input.avatarIndex },",
  "appearance: { ...(previous?.appearance ?? {}), avatarIndex: input.avatarIndex, worldSkinIndex: input.avatarIndex },",
)
replace(
`      setDossiers((current) => {
        const dossier = current[managingEmployee.id]
        return dossier === undefined
          ? current
          : { ...current, [managingEmployee.id]: { ...dossier, employee: { ...dossier.employee, displayName: input.displayName, updatedAt }, ...(profile === undefined ? {} : { profile }) } }
      })`,
`      setDossiers((current) => {
        const dossier = current[managingEmployee.id]
        return dossier === undefined
          ? current
          : { ...current, [managingEmployee.id]: { ...dossier, employee: { ...dossier.employee, displayName: input.displayName, updatedAt }, ...(profile === undefined ? {} : { profile }) } }
      })
      setWorldRuntimeRevision((value) => value + 1)`,
)
replace(
`                  onSelectEmployee={(employeeId) => {
                    const employee = employees.find((item) => item.id === employeeId)
                    if (employee !== undefined) directEmployee(employee)
                  }}
                  onRecruit={() => void openRecruitment()}`,
`                  onSelectEmployee={(employeeId) => {
                    const employee = employees.find((item) => item.id === employeeId)
                    if (employee !== undefined) directEmployee(employee)
                  }}
                  onStartGroup={(employeeIds) => {
                    const selected = employees.filter((employee) => employeeIds.includes(employee.id))
                    if (selected.length < 2) return
                    createGroupIntent({ employeeIds: selected.map((employee) => employee.id), title: selected.map((employee) => employee.displayName).join('、') })
                  }}
                  onRecruit={() => void openRecruitment()}`,
)
replace(
`          blueprints={blueprints}
          world={activeWorld}`,
`          blueprints={blueprints}
          employees={employees}
          world={activeWorld}`,
)
replace("if (employee.status === 'blocked') return '等待依赖或老板推进'", "if (employee.status === 'blocked') return '等待依赖或进一步处理'")

await writeFile(path, source, 'utf8')
console.log('App wiring fixes applied.')
