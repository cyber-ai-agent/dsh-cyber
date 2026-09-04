import { describe, expect, it } from 'vitest'

import { validateProviderProfile, type HarnessProviderProfile } from '../src/profile.js'

function provider(baseURL: string): HarnessProviderProfile {
  return {
    route: 'local-gateway',
    displayName: '局域网网关',
    api: 'openai-completions',
    baseURL,
    model: { id: 'qwen-9b' },
  }
}

describe('provider URL transport policy', () => {
  it('accepts HTTPS anywhere, including public hosts', () => {
    expect(() => validateProviderProfile(provider('https://api.deepseek.com/v1'))).not.toThrow()
    expect(() => validateProviderProfile(provider('https://172.16.1.125:8000/v1'))).not.toThrow()
  })

  it('accepts plain HTTP on loopback and explicit private-network addresses', () => {
    for (const url of [
      'http://127.0.0.1:8000/v1',
      'http://localhost:1234/v1',
      'http://[::1]:8000/v1',
      'http://10.0.3.7:8080/v1',
      'http://172.16.1.125:8000/v1',
      'http://172.31.255.255:8000/v1',
      'http://192.168.0.9:8000/v1',
      'http://[fc00::12]:8000/v1',
      'http://box.local:8000/v1',
      'http://host.docker.internal:8000/v1',
    ]) {
      expect(() => validateProviderProfile(provider(url)), url).not.toThrow()
    }
  })

  it('rejects plain HTTP for public addresses, public hostnames and link-local', () => {
    for (const url of [
      'http://8.8.8.8/v1',
      'http://172.32.0.1:8000/v1',
      'http://11.16.1.1:8000/v1',
      'http://169.254.1.1:8000/v1',
      'http://models.example.com/v1',
    ]) {
      expect(() => validateProviderProfile(provider(url)), url).toThrow(/must use HTTPS/)
    }
  })

  it('rejects non-HTTP(S) transports even on private hosts', () => {
    for (const url of [
      'ftp://127.0.0.1/v1',
      'ws://192.168.1.10:8080/v1',
      'file:///C:/model',
    ]) {
      expect(() => validateProviderProfile(provider(url)), url).toThrow(/must use HTTPS/)
    }
  })

  it('172.16 boundary follows RFC1918: /12 in, 172.32 out', () => {
    expect(() => validateProviderProfile(provider('http://172.16.0.1:8000/v1'))).not.toThrow()
    expect(() => validateProviderProfile(provider('http://172.31.0.1:8000/v1'))).not.toThrow()
    expect(() => validateProviderProfile(provider('http://172.32.0.1:8000/v1'))).toThrow(/must use HTTPS/)
  })

  it('still validates the rest of the profile', () => {
    expect(() => validateProviderProfile({ ...provider('http://127.0.0.1:8000/v1'), apiKeyEnv: 'bad-name' })).toThrow(/credential environment variable/)
    expect(() => validateProviderProfile({ ...provider('https://api.example.com/v1'), webSearch: { baseURL: 'http://search.example.com/v1', apiKeyEnv: 'SEARCH_KEY' } })).toThrow(/search URL must use HTTPS/)
  })
})
