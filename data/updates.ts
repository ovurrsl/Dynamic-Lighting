/**
 * The update manifest, checked in rather than stored in the database.
 *
 * Releases are a git operation anyway (tag, build, publish artefacts), so keeping
 * the manifest next to them means a release is one commit and one deploy, with no
 * chance of the database and the published binaries disagreeing.
 *
 * Edited as part of a release commit.
 */

export interface ArtefactInfo {
  version: string
  url: string | null
  sha256: string | null
  notes: string
  board?: string
}

export interface ChannelInfo {
  engine: ArtefactInfo
  firmware: ArtefactInfo
}

export const CHANNELS = ['stable', 'beta'] as const
export type ChannelName = (typeof CHANNELS)[number]

export const manifest: Partial<Record<ChannelName, ChannelInfo>> = {
  stable: {
    engine: {
      version: '0.0.0',
      url: null,
      sha256: null,
      notes: 'No engine build published yet.'
    },
    firmware: {
      version: '0.0.0',
      board: 'arduino_nano_esp32',
      url: null,
      sha256: null,
      notes: 'No firmware build published yet.'
    }
  }
}
