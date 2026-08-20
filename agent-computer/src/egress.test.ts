/**
 * Bateria do egress anti-SSRF — resolver INJETADO (nenhum teste depende do DNS
 * da rede). O ponto da frente: o veredito é sobre o que o nome RESOLVE, não
 * sobre a cara que ele tem.
 */

import { describe, expect, it, vi } from 'vitest'
import { checkNavigationTarget, isPrivateIpv4, isPrivateIpv6 } from './egress.js'

const publicIp = '93.184.216.34'

describe('isPrivateIpv4 / isPrivateIpv6', () => {
  it('classifica as faixas privadas do IPv4', () => {
    for (const address of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '172.16.9.1', '192.168.1.1', '0.0.0.0']) {
      expect(isPrivateIpv4(address), address).toBe(true)
    }
    expect(isPrivateIpv4(publicIp)).toBe(false)
    expect(isPrivateIpv4('172.32.0.1')).toBe(false)
    expect(isPrivateIpv4('não é ip')).toBe(false)
  })

  it('classifica loopback, link-local, unique-local e IPv4 mapeado do IPv6', () => {
    for (const address of ['::1', '::', 'fe80::1', 'fc00::abcd', 'fdff::1', '::ffff:192.168.0.1']) {
      expect(isPrivateIpv6(address), address).toBe(true)
    }
    expect(isPrivateIpv6('2606:4700::1')).toBe(false)
    expect(isPrivateIpv6('::ffff:93.184.216.34')).toBe(false)
  })
})

describe('checkNavigationTarget', () => {
  it('recusa o que não é endereço web', async () => {
    expect((await checkNavigationTarget('nada disso')).allowed).toBe(false)
    expect((await checkNavigationTarget('ftp://arquivos.exemplo.com/x')).allowed).toBe(false)
    expect((await checkNavigationTarget('file:///etc/passwd')).allowed).toBe(false)
  })

  it('metadata de nuvem é recusada SEMPRE — nem o opt-in a alcança', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://metadata.goog/x',
    ]) {
      const verdict = await checkNavigationTarget(url, { allowPrivateHosts: true })
      expect(verdict.allowed, url).toBe(false)
    }
  })

  it('IP literal privado é recusado sem resolver nada', async () => {
    const resolve = vi.fn()
    const verdict = await checkNavigationTarget('http://10.0.0.5:8080/painel', { resolve })
    expect(verdict.allowed).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('localhost e ::1 são recusados por padrão e liberados só pelo opt-in', async () => {
    expect((await checkNavigationTarget('http://localhost:3000/')).allowed).toBe(false)
    expect((await checkNavigationTarget('http://[::1]:3000/')).allowed).toBe(false)
    const optIn = await checkNavigationTarget('http://localhost:3000/', {
      allowPrivateHosts: true,
    })
    expect(optIn.allowed).toBe(true)
  })

  it('O CASO DA FRENTE: nome bonito que resolve para IP privado é recusado DEPOIS de resolver', async () => {
    const verdict = await checkNavigationTarget('http://painel.interno.corp/', {
      resolve: async () => ['10.0.0.5'],
    })
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) {
      expect(verdict.reason).toContain('10.0.0.5')
    }
  })

  it('basta UM endereço privado na resposta para recusar', async () => {
    const verdict = await checkNavigationTarget('http://cdn.exemplo.com/', {
      resolve: async () => [publicIp, '192.168.7.7'],
    })
    expect(verdict.allowed).toBe(false)
  })

  it('nome que resolve para a metadata é recusado até com opt-in', async () => {
    const verdict = await checkNavigationTarget('http://sosia.exemplo.com/', {
      allowPrivateHosts: true,
      resolve: async () => ['169.254.169.254'],
    })
    expect(verdict.allowed).toBe(false)
  })

  it('nome que resolve para endereço público navega', async () => {
    const verdict = await checkNavigationTarget('https://exemplo.com/docs', {
      resolve: async () => [publicIp],
    })
    expect(verdict.allowed).toBe(true)
  })

  it('IPv6 privado resolvido também recusa', async () => {
    const verdict = await checkNavigationTarget('http://app.exemplo.com/', {
      resolve: async () => ['fe80::1'],
    })
    expect(verdict.allowed).toBe(false)
  })

  it('falha de resolução é fail closed, com o motivo', async () => {
    const verdict = await checkNavigationTarget('http://nao-existe.exemplo/', {
      resolve: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) {
      expect(verdict.reason).toContain('ENOTFOUND')
    }
  })

  it('IP literal público não precisa de DNS', async () => {
    const resolve = vi.fn()
    const verdict = await checkNavigationTarget(`http://${publicIp}/`, { resolve })
    expect(verdict.allowed).toBe(true)
    expect(resolve).not.toHaveBeenCalled()
  })
})
