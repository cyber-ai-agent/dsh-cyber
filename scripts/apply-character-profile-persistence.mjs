import { readFile, writeFile } from 'node:fs/promises'

const path = 'packages/web/src/App.tsx'
const source = await readFile(path, 'utf8')
const startMarker = '  const updateEmployeeProfile = useCallback(async ('
const endMarker = '\n\n  const archiveEmployee = useCallback(async () => {'
const start = source.indexOf(startMarker)
const end = source.indexOf(endMarker, start)
if (start < 0 || end < 0) throw new Error('Unable to locate updateEmployeeProfile block')

const replacement = `  const updateEmployeeProfile = useCallback(async (input: {
    displayName: string
    avatarIndex: number
    background: string
    personalityTraits: string[]
    relationshipToUser: string
    addressUserAs: string
    selfReference: string
  }) => {
    if (managingEmployee === undefined) return
    setSavingEmployee(true)
    setError(undefined)
    try {
      const previous = dossiers[managingEmployee.id]?.profile
      const appearance = {
        ...(previous?.appearance ?? {}),
        avatarIndex: input.avatarIndex,
        worldSkinIndex: input.avatarIndex,
        relationshipToUser: input.relationshipToUser,
        addressUserAs: input.addressUserAs,
        selfReference: input.selfReference,
      }
      let profile = previous
      if (demoMode) {
        profile = {
          employeeId: managingEmployee.id,
          revision: (previous?.revision ?? 0) + 1,
          background: input.background,
          personalityTraits: input.personalityTraits,
          appearance,
          reason: '更新角色资料与关系设定',
          createdAt: new Date().toISOString(),
          ...(previous?.birthday === undefined ? {} : { birthday: previous.birthday }),
        }
      } else {
        const result = await api<{ profile: EmployeeDossier['profile'] }>('/api/employees/' + managingEmployee.id + '/profile', {
          method: 'PUT',
          body: JSON.stringify({
            displayName: input.displayName,
            background: input.background,
            personalityTraits: input.personalityTraits,
            appearance,
            reason: '更新角色资料与关系设定',
          }),
        })
        profile = result.profile
      }
      const updatedAt = profile?.createdAt ?? new Date().toISOString()
      setEmployees((current) => current.map((employee) => employee.id === managingEmployee.id
        ? { ...employee, displayName: input.displayName, avatarIndex: input.avatarIndex, updatedAt }
        : employee))
      setDossiers((current) => {
        const dossier = current[managingEmployee.id]
        return dossier === undefined
          ? current
          : { ...current, [managingEmployee.id]: { ...dossier, employee: { ...dossier.employee, displayName: input.displayName, updatedAt }, ...(profile === undefined ? {} : { profile }) } }
      })
      setWorldRuntimeRevision((value) => value + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '角色资料保存失败')
    } finally {
      setSavingEmployee(false)
    }
  }, [dossiers, managingEmployee])`

await writeFile(path, source.slice(0, start) + replacement + source.slice(end), 'utf8')
