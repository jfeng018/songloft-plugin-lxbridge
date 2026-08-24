import { describe, expect, it } from 'vitest';
import { gzip } from 'pako';
import { parseLxmcBytes } from '../../src/songlist/lxmc';

function encode(value: unknown, compressed = true): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return compressed ? gzip(bytes) : bytes;
}

describe('LX Music backup parsing', () => {
  it('extracts only playlists from an allData_v3 gzip backup', () => {
    const result = parseLxmcBytes(encode({
      type: 'allData_v3',
      data: {
        lists: {
          defaultList: [],
          loveList: [{ id: 'wy_1', name: '歌曲一', singer: '歌手一', source: 'wy', interval: '04:05', meta: { songId: 1, albumName: '专辑一', picUrl: 'cover' } }],
          userList: [{ id: 'list-1', name: '收藏歌单', list: [{ id: 'tx_2', name: '歌曲二', singer: '歌手二', source: 'tx', interval: '03:10', meta: { songmid: 'mid-2' } }] }],
          tempList: [],
        },
        settings: { token: 'must-not-be-read' },
        userApis: [{ script: 'must-not-be-read' }],
        playHistory: [{ name: '历史歌曲', source: 'wy' }],
      },
    }));

    expect(result.backup_type).toBe('allData_v3');
    expect(result.total_songs).toBe(2);
    expect(result.playlists.map(item => item.name)).toEqual(['我的收藏', '收藏歌单']);
    expect(result.playlists[0].songs[0]).toMatchObject({ source: 'wy', name: '歌曲一', singer: '歌手一', duration: 245, songId: 1, albumName: '专辑一', img: 'cover' });
    expect(JSON.stringify(result)).not.toContain('must-not-be-read');
    expect(JSON.stringify(result)).not.toContain('历史歌曲');
  });

  it('accepts an uncompressed playlist-only JSON backup', () => {
    const result = parseLxmcBytes(encode({
      type: 'playList',
      data: { defaultList: [{ id: 'kg_1', name: '本地列表歌曲', singer: '歌手', source: 'kg', interval: '00:59', meta: {} }], loveList: [], userList: [] },
    }, false));
    expect(result.playlists[0]).toMatchObject({ id: 'default', name: '默认列表' });
    expect(result.playlists[0].songs[0].duration).toBe(59);
  });

  it('accepts a playListPart_v2 single-playlist gzip backup', () => {
    const result = parseLxmcBytes(encode({
      type: 'playListPart_v2',
      data: {
        name: '测试',
        id: 'userlist_1787568625624',
        locationUpdateTime: null,
        list: [
          { id: 'mg_1', name: '咪咕歌曲', singer: '歌手一', source: 'mg', interval: '04:15', meta: { songId: '1' } },
          { id: 'wy_2', name: '网易云歌曲', singer: '歌手二', source: 'wy', interval: '03:20', meta: { songId: 2 } },
        ],
      },
    }));

    expect(result.backup_type).toBe('playListPart_v2');
    expect(result.total_songs).toBe(2);
    expect(result.playlists).toHaveLength(1);
    expect(result.playlists[0]).toMatchObject({
      id: 'user:userlist_1787568625624',
      name: '测试',
      kind: 'user',
    });
    expect(result.playlists[0].songs.map(song => song.source)).toEqual(['mg', 'wy']);
  });

  it('rejects backups without supported playlist songs', () => {
    expect(() => parseLxmcBytes(encode({ type: 'allData_v3', data: { lists: { defaultList: [], loveList: [], userList: [] }, settings: { name: 'not a song' } } })))
      .toThrow('没有可导入歌曲');
  });
});
