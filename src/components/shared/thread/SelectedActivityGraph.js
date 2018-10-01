/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import React, { PureComponent } from 'react';
import explicitConnect from '../../../utils/connect';
import ThreadActivityGraph from './ActivityGraph';
import ThreadStackGraph from './StackGraph';
import { withChartViewport } from '../chart/Viewport';
import {
  selectedThreadSelectors,
  getPreviewSelection,
  getProfile,
  getCommittedRange,
} from '../../../reducers/profile-view';
import { getSelectedThreadIndex } from '../../../reducers/url-state';
import {
  getCallNodePathFromIndex,
  getSampleCallNodes,
} from '../../../profile-logic/profile-data';
import {
  changeSelectedCallNode,
  focusCallTree,
} from '../../../actions/profile-view';

import type {
  Thread,
  ThreadIndex,
  CategoryList,
  StackTable,
  SamplesTable,
  IndexIntoSamplesTable,
  IndexIntoCategoryList,
} from '../../../types/profile';
import type { Milliseconds } from '../../../types/units';
import type {
  CallNodeInfo,
  IndexIntoCallNodeTable,
} from '../../../types/profile-derived';
import type { State } from '../../../types/reducers';
import type {
  ExplicitConnectOptions,
  ConnectedProps,
} from '../../../utils/connect';
import type { Viewport } from '../chart/Viewport';

type OwnProps = {|
  // The viewport property is injected by the withViewport component, but is not
  // actually used or needed in this case. However, withViewport has side effects
  // of enabling event listeners for adjusting the view.
  +viewport: Viewport,
|};

type StateProps = {|
  +selectedThreadIndex: ThreadIndex,
  +interval: Milliseconds,
  +rangeStart: Milliseconds,
  +rangeEnd: Milliseconds,
  +fullThread: Thread,
  +filteredThread: Thread,
  +callNodeInfo: CallNodeInfo,
  +selectedCallNodeIndex: IndexIntoCallNodeTable | null,
  +categories: CategoryList,
  +samplesSelectedStates: boolean[],
  +treeOrderSampleComparator: (
    IndexIntoSamplesTable,
    IndexIntoSamplesTable
  ) => number,
|};

type DispatchProps = {|
  +changeSelectedCallNode: typeof changeSelectedCallNode,
  +focusCallTree: typeof focusCallTree,
|};

type Props = ConnectedProps<OwnProps, StateProps, DispatchProps>;

function findBestCallNode(
  callNodeInfo: CallNodeInfo,
  sampleCallNodes: Array<IndexIntoCallNodeTable | null>,
  sampleCategories: Array<IndexIntoCategoryList | null>,
  clickedCallNode: IndexIntoCallNodeTable,
  clickedCategory: IndexIntoCategoryList
): IndexIntoCallNodeTable {
  const { callNodeTable } = callNodeInfo;
  if (callNodeTable.category[clickedCallNode] !== clickedCategory) {
    return clickedCallNode;
  }

  const clickedDepth = callNodeTable.depth[clickedCallNode];
  const callNodesOnSameCategoryPath = [clickedCallNode];
  let callNode = clickedCallNode;
  while (true) {
    const parentCallNode = callNodeTable.prefix[callNode];
    if (parentCallNode === -1) {
      // The entire call path is just clickedCategory.
      return clickedCallNode; // TODO: is this a useful behavior?
    }
    if (callNodeTable.category[parentCallNode] !== clickedCategory) {
      break;
    }
    callNodesOnSameCategoryPath.push(parentCallNode);
    callNode = parentCallNode;
  }

  // Now find the callNode in callNodesOnSameCategoryPath with the lowest depth
  // such that selecting it will not highlight any samples whose unfiltered
  // category is different from clickedCategory. If no such callNode exists,
  // return clickedCallNode.

  const handledCallNodes = new Uint8Array(callNodeTable.length);
  function limitSameCategoryPathToCommonAncestor(callNode) {
    const walkUpToDepth =
      clickedDepth - (callNodesOnSameCategoryPath.length - 1);
    let depth = callNodeTable.depth[callNode];
    while (depth >= walkUpToDepth) {
      if (handledCallNodes[callNode]) {
        return;
      }
      handledCallNodes[callNode] = 1;
      if (depth <= clickedDepth) {
        if (callNode === callNodesOnSameCategoryPath[clickedDepth - depth]) {
          callNodesOnSameCategoryPath.length = clickedDepth - depth;
          return;
        }
      }
      callNode = callNodeTable.prefix[callNode];
      depth--;
    }
  }

  for (let sample = 0; sample < sampleCallNodes.length; sample++) {
    if (
      sampleCategories[sample] !== clickedCategory &&
      sampleCallNodes[sample] !== null
    ) {
      limitSameCategoryPathToCommonAncestor(sampleCallNodes[sample]);
    }
  }

  if (callNodesOnSameCategoryPath.length > 0) {
    return callNodesOnSameCategoryPath[callNodesOnSameCategoryPath.length - 1];
  }
  return clickedCallNode;
}

function getSampleCategories(
  samples: SamplesTable,
  stackTable: StackTable
): Array<IndexIntoSamplesTable | null> {
  return samples.stack.map(s => (s !== null ? stackTable.category[s] : null));
}

class SelectedThreadActivityGraphCanvas extends PureComponent<Props> {
  _onSampleClick = (sampleIndex: IndexIntoSamplesTable) => {
    const {
      fullThread,
      filteredThread,
      callNodeInfo,
      selectedThreadIndex,
      changeSelectedCallNode,
      focusCallTree,
    } = this.props;
    const unfilteredStack = fullThread.samples.stack[sampleIndex];
    if (unfilteredStack === null) {
      return;
    }

    const clickedCategory = fullThread.stackTable.category[unfilteredStack];
    const { callNodeTable, stackIndexToCallNodeIndex } = callNodeInfo;
    const sampleCallNodes = getSampleCallNodes(
      filteredThread.samples,
      stackIndexToCallNodeIndex
    );
    const clickedCallNode = sampleCallNodes[sampleIndex];
    if (clickedCallNode === null) {
      return;
    }

    const sampleCategories = getSampleCategories(
      fullThread.samples,
      fullThread.stackTable
    );
    const chosenCallNode = findBestCallNode(
      callNodeInfo,
      sampleCallNodes,
      sampleCategories,
      clickedCallNode,
      clickedCategory
    );
    // Change selection twice: First, to clickedCallNode, in order to expand
    // the whole call path. Then, to chosenCallNode, to get the large-area
    // graph highlighting.
    changeSelectedCallNode(
      selectedThreadIndex,
      getCallNodePathFromIndex(clickedCallNode, callNodeTable)
    );
    changeSelectedCallNode(
      selectedThreadIndex,
      getCallNodePathFromIndex(chosenCallNode, callNodeTable)
    );
    focusCallTree();
  };
  render() {
    const {
      fullThread,
      filteredThread,
      interval,
      rangeStart,
      rangeEnd,
      callNodeInfo,
      selectedCallNodeIndex,
      categories,
      samplesSelectedStates,
      treeOrderSampleComparator,
    } = this.props;

    return (
      <div>
        <ThreadActivityGraph
          interval={interval}
          fullThread={fullThread}
          className="selectedThreadActivityGraph"
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          onSampleClick={this._onSampleClick}
          categories={categories}
          samplesSelectedStates={samplesSelectedStates}
          treeOrderSampleComparator={treeOrderSampleComparator}
        />
        <ThreadStackGraph
          interval={interval}
          thread={filteredThread}
          className="selectedThreadStackGraph"
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          callNodeInfo={callNodeInfo}
          selectedCallNodeIndex={selectedCallNodeIndex}
          onSampleClick={this._onSampleClick}
          categories={categories}
          stacksGrowFromCeiling={true}
        />
      </div>
    );
  }
}

const SelectedThreadActivityGraphCanvasWithViewport = withChartViewport(
  SelectedThreadActivityGraphCanvas
);

/**
 * The viewport contents never change size from this component, so it never needs
 * explicit updating, outside of how the viewport manages its own size and positioning.
 */
function viewportNeedsUpdate() {
  return false;
}

class SelectedThreadActivityGraph extends PureComponent<*> {
  render() {
    const {
      interval,
      selectedThreadIndex,
      fullThread,
      filteredThread,
      rangeStart,
      rangeEnd,
      callNodeInfo,
      selectedCallNodeIndex,
      categories,
      samplesSelectedStates,
      treeOrderSampleComparator,
      previewSelection,
      changeSelectedCallNode,
      focusCallTree,
      timeRange,
    } = this.props;
    return (
      <SelectedThreadActivityGraphCanvasWithViewport
        chartProps={{
          interval,
          selectedThreadIndex,
          fullThread,
          filteredThread,
          rangeStart,
          rangeEnd,
          callNodeInfo,
          selectedCallNodeIndex,
          categories,
          samplesSelectedStates,
          treeOrderSampleComparator,
          changeSelectedCallNode,
          focusCallTree,
        }}
        viewportProps={{
          timeRange: timeRange,
          maxViewportHeight: 0,
          maximumZoom: 0.0001,
          previewSelection,
          startsAtBottom: true,
          disableHorizontalMovement: false,
          className: 'selectedThreadActivityGraphViewport',
          viewportNeedsUpdate,
          marginLeft: 0,
          marginRight: 0,
        }}
      />
    );
  }
}

const options: ExplicitConnectOptions<*, *, *> = {
  mapStateToProps: (state: State) => {
    const committedRange = getCommittedRange(state);
    const previewSelection = getPreviewSelection(state);
    const rangeStart = previewSelection.hasSelection
      ? previewSelection.selectionStart
      : committedRange.start;
    const rangeEnd = previewSelection.hasSelection
      ? previewSelection.selectionEnd
      : committedRange.end;
    return {
      interval: getProfile(state).meta.interval,
      selectedThreadIndex: getSelectedThreadIndex(state),
      fullThread: selectedThreadSelectors.getRangeFilteredThread(state),
      filteredThread: selectedThreadSelectors.getFilteredThread(state),
      rangeStart,
      rangeEnd,
      callNodeInfo: selectedThreadSelectors.getCallNodeInfo(state),
      selectedCallNodeIndex: selectedThreadSelectors.getSelectedCallNodeIndex(
        state
      ),
      categories: getProfile(state).meta.categories,
      samplesSelectedStates: selectedThreadSelectors.getSamplesSelectedStatesInFilteredThread(
        state
      ),
      treeOrderSampleComparator: selectedThreadSelectors.getTreeOrderComparatorInFilteredThread(
        state
      ),
      timeRange: getCommittedRange(state),
      previewSelection,
    };
  },
  mapDispatchToProps: {
    changeSelectedCallNode,
    focusCallTree,
  },
  component: SelectedThreadActivityGraph,
};
export default explicitConnect(options);
