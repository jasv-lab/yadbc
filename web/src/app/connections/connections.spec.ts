import { describe, expect, it } from 'vitest'
import { ConnectionProfile } from '../core/protocol'
import { grouped } from './connections'

const c = (name: string, env: ConnectionProfile['env'], group?: string): ConnectionProfile => ({
  id: name,
  name,
  env,
  group,
  host: 'h',
  port: 5432,
  database: 'd',
  username: 'u',
})

describe('grouped', () => {
  it('groups by name ignoring case, local → dev → prod inside, ungrouped last', () => {
    const groups = grouped([
      c('loose', 'dev'),
      c('cmdb-prod', 'prod', 'CMDB'),
      c('billing', 'dev', 'Billing'),
      c('cmdb-dev', 'dev', 'cmdb'),
      c('cmdb-local', 'local', 'CMDB '),
    ])
    expect(groups.map((g) => [g.name, g.connections.map((x) => x.name)])).toEqual([
      ['Billing', ['billing']],
      ['CMDB', ['cmdb-local', 'cmdb-dev', 'cmdb-prod']],
      [null, ['loose']],
    ])
  })
})
