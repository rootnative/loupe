import { describe, expect, it } from 'vitest'
import { isExpoGoOverlay, scrollAxisOf, type UiNode } from './ui'

function node(type: string): UiNode {
  return { type, frame: { x: 0, y: 0, width: 100, height: 100 } }
}

const EXPO_GO = 'host.exp.exponent'

describe('isExpoGoOverlay', () => {
  it('is a node of a class that is not android.*, in Expo Go on Android', () => {
    expect(isExpoGoOverlay(node('c23'), EXPO_GO, 'android')).toBe(true)
    expect(
      isExpoGoOverlay(node('android.view.ViewGroup'), EXPO_GO, 'android'),
    ).toBe(false)
  })

  it('is no node of another app, or of a tree with no app', () => {
    expect(isExpoGoOverlay(node('c23'), 'com.example.app', 'android')).toBe(
      false,
    )
    expect(isExpoGoOverlay(node('c23'), undefined, 'android')).toBe(false)
  })

  it('is no node of an iOS tree, where no type is android.*', () => {
    expect(isExpoGoOverlay(node('other'), EXPO_GO, 'ios')).toBe(false)
    expect(isExpoGoOverlay(node('image'), 'host.exp.Exponent', 'ios')).toBe(
      false,
    )
  })
})

describe('scrollAxisOf', () => {
  it('reads the axis from the class on Android', () => {
    expect(
      scrollAxisOf(node('android.widget.HorizontalScrollView'), 'android'),
    ).toBe('x')
    expect(
      scrollAxisOf(node('androidx.viewpager.widget.ViewPager'), 'android'),
    ).toBe('x')
    expect(scrollAxisOf(node('android.widget.ScrollView'), 'android')).toBe('y')
  })

  it('counts each scroll view of an iOS tree as one along y', () => {
    expect(scrollAxisOf(node('scrollView'), 'ios')).toBe('y')
    expect(
      scrollAxisOf(node('android.widget.HorizontalScrollView'), 'ios'),
    ).toBe('y')
  })
})
