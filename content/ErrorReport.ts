let $window: Window & {
  arguments?: any[]
  ErrorReport?: ErrorReport
}

Components.utils.import('resource://gre/modules/Services.jsm')

import { Preference } from './prefs'
import { defaults } from '../gen/preferences/meta'
import { Translators } from './translators'
import { log } from './logger'
import { AutoExport } from './auto-export'

import { DB } from './db/main'
import { DB as Cache } from './db/cache'
import { pick } from './file-picker'
import { is7 } from './client'
import * as l10n from './l10n'

import Tar from 'tar-js'
import { gzip } from 'pako'

import { alert } from './prompt'

import * as s3 from './s3.json'

import * as PACKAGE from '../package.json'

const kB = 1024

type WizardButton = HTMLElement & { disabled: boolean }

type Wizard = HTMLElement & {
  getButton: (name: string) => WizardButton
  getPageById: (id: string) => HTMLElement
  canRewind: boolean
  onLastPage: boolean
  pageIndex: number
  advance: () => void
  rewind: () => void
}

export class ErrorReport {
  private previewSize = 3 * kB // eslint-disable-line yoda

  private key: string
  private timestamp: string
  private tarball: string

  private bucket: string
  private params: any
  private cacheState: string

  private errorlog: {
    info: string
    errors: string
    debug: string
    items?: string
  }

  public async send(): Promise<void> {
    const doc = $window.document
    const wizard: Wizard = doc.getElementById('better-bibtex-error-report') as Wizard
    wizard.getButton('next').disabled = true
    wizard.getButton('cancel').disabled = true
    wizard.canRewind = false

    const version = require('../gen/version.js')

    try {
      await Zotero.HTTP.request('PUT', `${this.bucket}/${OS.Path.basename(this.tarball)}`, {
        noCache: true,
        // followRedirects: true,
        // noCache: true,
        // foreground: true,
        headers: {
          'x-amz-storage-class': 'STANDARD',
          'x-amz-acl': 'bucket-owner-full-control',
          'Content-Type': 'application/x-gzip',
        },
        body: this.tar(),
      })

      wizard.advance();

      // eslint-disable-next-line no-magic-numbers
      (<HTMLInputElement>doc.getElementById('better-bibtex-report-id')).value = `${this.key}/${version}-${is7 ? 7 : 6}${Zotero.BetterBibTeX.outOfMemory ? '/oom' : ''}`
      doc.getElementById('better-bibtex-report-result').hidden = false
    }
    catch (err) {
      log.error('failed to submit', this.key, err)
      alert({ text: `${err} (${this.key}, items: ${!!this.errorlog.items})`, title: Zotero.getString('general.error') })
      if (wizard.rewind) wizard.rewind()
    }
  }

  public show(): void {
    const doc = $window.document
    const wizard: Wizard = doc.getElementById('better-bibtex-error-report') as Wizard

    if (wizard.onLastPage) wizard.canRewind = false
    else if (wizard.pageIndex === 0) wizard.canRewind = false
    else if (wizard.pageIndex === 1 && Zotero.Debug.enabled) wizard.canRewind = false
    else wizard.canRewind = true
  }

  public restartWithDebugEnabled(): void {
    const ps = Components.classes['@mozilla.org/embedcomp/prompt-service;1'].getService(Components.interfaces.nsIPromptService)
    const buttonFlags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING
        + ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL
        + ps.BUTTON_POS_2 * ps.BUTTON_TITLE_IS_STRING
    const index = ps.confirmEx(
      null,
      Zotero.getString('zotero.debugOutputLogging'),
      Zotero.getString('zotero.debugOutputLogging.enabledAfterRestart', [Zotero.clientName]),
      buttonFlags,
      Zotero.getString('general.restartNow'),
      null, Zotero.getString('general.restartLater'), null, {}
    )

    if (index !== 1) Zotero.Prefs.set('debug.store', true)

    if (index === 0) Zotero.Utilities.Internal.quit(true)
  }

  private async latest() {
    try {
      const latest = PACKAGE.xpi.releaseURL.replace('https://github.com/', 'https://api.github.com/repos/').replace(/\/releases\/.*/, '/releases/latest')
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return JSON.parse((await Zotero.HTTP.request('GET', latest, { noCache: true })).response).tag_name.replace('v', '')
    }
    catch (err) {
      log.error('errorreport.latest:', err)
      return null
    }
  }

  public tar(): Uint8Array {
    const tape = new Tar
    let out: Uint8Array

    out = tape.append(`${this.key}/debug.txt`, [
      this.errorlog.info,
      this.cacheState,
      this.errorlog.errors,
      this.errorlog.debug,
    ].filter(chunk => chunk).join('\n\n'))

    if (this.errorlog.items) out = tape.append(`${this.key}/items.json`, this.errorlog.items)

    if ((<HTMLInputElement>$window.document.getElementById('better-bibtex-error-report-include-db')).checked) {
      out = tape.append(`${this.key}/database.json`, DB.serialize({ serializationMethod: 'pretty' }))
      out = tape.append(`${this.key}/cache.json`, Cache.serialize({ serializationMethod: 'pretty' }))
    }

    return gzip(out)
  }

  public async save(): Promise<void> {
    const filename = await pick('Logs', 'save', [['Tape Archive (*.tgz)', '*.tgz']], `${this.key}.tgz`)
    if (filename) await OS.File.writeAtomic(filename, this.tar(), { tmpPath: filename + '.tmp' })
  }

  private async ping(region: string) {
    await Zotero.HTTP.request('GET', `https://s3.${region}.amazonaws.com${s3.region[region].tld || ''}/ping`, { noCache: true })
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return { region, ...s3.region[region] }
  }

  private setValue(id: string, value: string) {
    (<HTMLInputElement>$window.document.getElementById(id)).value = value
  }

  public async load(win: Window): Promise<void> {
    $window = win as any
    $window.ErrorReport = this
    const doc = win.document

    this.timestamp = (new Date()).toISOString().replace(/\..*/, '').replace(/:/g, '.')

    const wizard: Wizard = doc.getElementById('better-bibtex-error-report') as Wizard
    wizard.getPageById('page-enable-debug').addEventListener('pageshow', this.show.bind(this))
    wizard.getPageById('page-review').addEventListener('pageshow', this.show.bind(this))
    wizard.getPageById('page-send').addEventListener('pageshow', () => { this.send().catch(err => log.debug('could not send debug log:', err)) })
    wizard.getPageById('page-done').addEventListener('pageshow', this.show.bind(this))

    if (Zotero.Debug.enabled) wizard.pageIndex = 1

    const continueButton = wizard.getButton('next')
    continueButton.disabled = true

    this.params = $window.arguments[0].wrappedJSObject

    this.errorlog = {
      info: await this.info(),
      errors: `${Zotero.BetterBibTeX.outOfMemory}\n${Zotero.getErrors(true).join('\n')}`.trim(),
      // # 1896
      debug: Zotero.Debug.getConsoleViewerOutput().slice(-500000).join('\n'), // eslint-disable-line no-magic-numbers
    }

    if (this.params.scope) {
      await Zotero.BetterBibTeX.ready
      this.errorlog.items = await Translators.exportItems({
        translatorID: Translators.bySlug.BetterBibTeXJSON.translatorID,
        displayOptions: {exportNotes: true, dropAttachments: true, Normalize: true},
        scope: this.params.scope,
      })
    }

    this.setValue('better-bibtex-error-context', this.errorlog.info)
    this.setValue('better-bibtex-error-errors', this.errorlog.errors)
    this.setValue('better-bibtex-error-debug', this.preview(this.errorlog.debug))
    if (this.errorlog.items) this.setValue('better-bibtex-error-items', this.preview(this.errorlog.items))
    doc.getElementById('better-bibtex-error-tab-items').hidden = !this.errorlog.items

    const current = require('../gen/version.js')
    this.setValue('better-bibtex-report-current', l10n.localize('better-bibtex_error-report_better-bibtex_current', { version: current }))

    try {
      const latest = await this.latest()

      const show_latest = <HTMLInputElement>doc.getElementById('better-bibtex-report-latest')
      if (current === latest) {
        show_latest.hidden = true
      }
      else {
        show_latest.value = l10n.localize('better-bibtex_error-report_better-bibtex_latest', { version: latest || '<could not be established>' })
        show_latest.hidden = false
      }

      (<HTMLInputElement>doc.getElementById('better-bibtex-report-latest')).hidden = !Zotero.BetterBibTeX.outOfMemory

      this.setValue('better-bibtex-report-cache', this.cacheState = l10n.localize('better-bibtex_error-report_better-bibtex_cache', Cache.state()))

      const region = await Zotero.Promise.any(Object.keys(s3.region).map(this.ping.bind(this)))
      this.bucket = `https://${s3.bucket}-${region.short}.s3-${region.region}.amazonaws.com${region.tld || ''}`
      this.key = `${Zotero.Utilities.generateObjectKey()}${this.params.scope ? '-refs' : ''}-${region.short}` // eslint-disable-line no-magic-numbers

      this.tarball = OS.Path.join(Zotero.getTempDirectory().path, `${this.key}-${this.timestamp}.tgz`)

      continueButton.disabled = false
      continueButton.focus()
    }
    catch (err) {
      alert({ text: `No AWS region can be reached: ${err.message}` })
      wizard.getButton('cancel').disabled = false
    }
  }

  private preview(text: string): string {
    return text.length > this.previewSize ? `${text.substr(0, this.previewSize)} ...` : text
  }

  // general state of Zotero
  private async info() {
    let info = ''

    const appInfo = Components.classes['@mozilla.org/xre/app-info;1'].getService(Components.interfaces.nsIXULAppInfo)
    info += `Application: ${appInfo.name} (${Zotero.clientName}) ${appInfo.version} ${Zotero.locale}\n`
    info += `Platform: ${Zotero.platform} ${Zotero.oscpu}\n`

    const addons = await Zotero.getInstalledExtensions()
    if (addons.length) {
      info += 'Addons:\n'
      for (const addon of addons) {
        info += `  ${addon}\n`
      }
    }

    info += 'Settings:\n'
    const settings = { default: '', set: '' }
    for (const [key, value] of Object.entries(Preference.all)) {
      settings[value === defaults[key] ? 'default' : 'set'] += `  ${key} = ${JSON.stringify(value)}\n`
    }
    if (settings.default) settings.default = `Settings at default:\n${settings.default}`
    info += settings.set + settings.default

    for (const key of ['export.quickCopy.setting']) {
      info += `  Zotero: ${key} = ${JSON.stringify(Zotero.Prefs.get(key))}\n`
    }

    const autoExports = await AutoExport.all()
    if (autoExports.length) {
      info += 'Auto-exports:\n'
      for (const ae of autoExports) {
        info += `  path: ${JSON.stringify(ae.path)}\n`
        for (const [k, v] of Object.entries(ae)) {
          if (k === 'path') continue
          info += `    ${k}: ${JSON.stringify(v)}`
          if (k === 'translatorID' && Translators.byId[v as string]) info += ` (${Translators.byId[v as string].label})`
          info += '\n'
        }
      }
    }

    info += `Zotero.Debug.enabled: ${Zotero.Debug.enabled}\n`
    info += `Zotero.Debug.enabled at start: ${Zotero.BetterBibTeX.debugEnabledAtStart}\n`

    return info
  }
}
