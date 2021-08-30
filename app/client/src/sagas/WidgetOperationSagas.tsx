import {
  ReduxAction,
  ReduxActionErrorTypes,
  ReduxActionTypes,
  WidgetReduxActionTypes,
} from "constants/ReduxActionConstants";
import {
  MultipleWidgetDeletePayload,
  updateAndSaveLayout,
  WidgetDelete,
  WidgetResize,
} from "actions/pageActions";
import {
  CanvasWidgetsReduxState,
  FlattenedWidgetProps,
} from "reducers/entityReducers/canvasWidgetsReducer";
import { getSelectedWidget, getWidget, getWidgets } from "./selectors";
import {
  all,
  call,
  fork,
  put,
  select,
  takeEvery,
  takeLatest,
} from "redux-saga/effects";
import { convertToString } from "utils/AppsmithUtils";
import {
  batchUpdateWidgetProperty,
  DeleteWidgetPropertyPayload,
  SetWidgetDynamicPropertyPayload,
  UpdateWidgetPropertyPayload,
  UpdateWidgetPropertyRequestPayload,
} from "actions/controlActions";
import {
  DynamicPath,
  getEntityDynamicBindingPathList,
  getWidgetDynamicPropertyPathList,
  getWidgetDynamicTriggerPathList,
  isChildPropertyPath,
  isDynamicValue,
  isPathADynamicBinding,
  isPathADynamicTrigger,
} from "utils/DynamicBindingUtils";
import { WidgetProps } from "widgets/BaseWidget";
import _, { cloneDeep, flattenDeep, isString, set, remove } from "lodash";
import WidgetFactory from "utils/WidgetFactory";
import { resetWidgetMetaProperty } from "actions/metaActions";
import {
  GridDefaults,
  MAIN_CONTAINER_WIDGET_ID,
  RenderModes,
  WIDGET_DELETE_UNDO_TIMEOUT,
  WidgetTypes,
} from "constants/WidgetConstants";
import WidgetConfigResponse from "mockResponses/WidgetConfigResponse";
import {
  flushDeletedWidgets,
  getCopiedWidgets,
  getDeletedWidgets,
  saveCopiedWidgets,
  saveDeletedWidgets,
} from "utils/storage";
import { generateReactKey } from "utils/generators";
import { flashElementsById } from "utils/helpers";
import AnalyticsUtil from "utils/AnalyticsUtil";
import log from "loglevel";
import { navigateToCanvas } from "pages/Editor/Explorer/Widgets/utils";
import {
  getCurrentApplicationId,
  getCurrentPageId,
} from "selectors/editorSelectors";
import {
  closePropertyPane,
  closeTableFilterPane,
  forceOpenPropertyPane,
} from "actions/widgetActions";
import {
  selectMultipleWidgetsInitAction,
  selectWidgetInitAction,
} from "actions/widgetSelectionActions";

import { getDataTree } from "selectors/dataTreeSelectors";
import {
  clearEvalPropertyCacheOfWidget,
  validateProperty,
} from "./EvaluationsSaga";
import { Toaster } from "components/ads/Toast";
import { Variant } from "components/ads/common";
import { ColumnProperties } from "components/designSystems/appsmith/TableComponent/Constants";
import {
  getAllPathsFromPropertyConfig,
  nextAvailableRowInContainer,
} from "entities/Widget/utils";
import { getAllPaths } from "workers/evaluationUtils";
import {
  createMessage,
  ERROR_WIDGET_COPY_NO_WIDGET_SELECTED,
  ERROR_WIDGET_CUT_NO_WIDGET_SELECTED,
  WIDGET_COPY,
  WIDGET_CUT,
  WIDGET_DELETE,
  WIDGET_BULK_DELETE,
  ERROR_WIDGET_COPY_NOT_ALLOWED,
} from "constants/messages";
import AppsmithConsole from "utils/AppsmithConsole";
import { ENTITY_TYPE } from "entities/AppsmithConsole";
import LOG_TYPE from "entities/AppsmithConsole/logtype";
import {
  CopiedWidgetGroup,
  doesTriggerPathsContainPropertyPath,
  getParentBottomRowAfterAddingWidget,
  getParentWidgetIdForPasting,
  getWidgetChildren,
  groupWidgetsIntoContainer,
  handleSpecificCasesWhilePasting,
  getSelectedWidgetWhenPasting,
  createSelectedWidgetsAsCopiedWidgets,
  filterOutSelectedWidgets,
  isSelectedWidgetsColliding,
  getBoundaryWidgetsFromCopiedGroups,
  getAllWidgetsInTree,
  createWidgetCopy,
  getNextWidgetName,
} from "./WidgetOperationUtils";
import { getSelectedWidgets } from "selectors/ui";
import { getParentWithEnhancementFn } from "./WidgetEnhancementHelpers";
import { widgetSelectionSagas } from "./WidgetSelectionSagas";
import { DataTree } from "entities/DataTree/dataTreeFactory";
import { updateCanvasSizeAfterWidgetMove } from "./DraggingCanvasSagas";
import widgetAdditionSagas from "./WidgetAdditionSagas";

/**
 * Note: Mutates finalWidgets[parentId].bottomRow for CANVAS_WIDGET
 * @param finalWidgets
 * @param parentId
 */
const resizeCanvasToLowestWidget = (
  finalWidgets: CanvasWidgetsReduxState,
  parentId: string,
) => {
  if (
    !finalWidgets[parentId] ||
    finalWidgets[parentId].type !== WidgetTypes.CANVAS_WIDGET
  ) {
    return;
  }

  let lowestBottomRow = Math.ceil(
    (finalWidgets[parentId].minHeight || 0) /
      GridDefaults.DEFAULT_GRID_ROW_HEIGHT,
  );
  const childIds = finalWidgets[parentId].children || [];

  // find lowest row
  childIds.forEach((cId) => {
    const child = finalWidgets[cId];

    if (child.bottomRow > lowestBottomRow) {
      lowestBottomRow = child.bottomRow;
    }
  });
  finalWidgets[parentId].bottomRow =
    (lowestBottomRow + GridDefaults.CANVAS_EXTENSION_OFFSET) *
    GridDefaults.DEFAULT_GRID_ROW_HEIGHT;
};

export function* deleteAllSelectedWidgetsSaga(
  deleteAction: ReduxAction<MultipleWidgetDeletePayload>,
) {
  try {
    const { disallowUndo = false } = deleteAction.payload;
    const stateWidgets = yield select(getWidgets);
    const widgets = { ...stateWidgets };
    const selectedWidgets: string[] = yield select(getSelectedWidgets);
    if (!(selectedWidgets && selectedWidgets.length !== 1)) return;
    const widgetsToBeDeleted = yield all(
      selectedWidgets.map((eachId) => {
        return call(getAllWidgetsInTree, eachId, widgets);
      }),
    );
    const falttendedWidgets: any = flattenDeep(widgetsToBeDeleted);
    const parentUpdatedWidgets = falttendedWidgets.reduce(
      (allWidgets: any, eachWidget: any) => {
        const { parentId, widgetId } = eachWidget;
        const stateParent: FlattenedWidgetProps = allWidgets[parentId];
        let parent = { ...stateParent };
        if (parent.children) {
          parent = {
            ...parent,
            children: parent.children.filter((c) => c !== widgetId),
          };
          allWidgets[parentId] = parent;
        }
        return allWidgets;
      },
      widgets,
    );
    const finalWidgets: CanvasWidgetsReduxState = _.omit(
      parentUpdatedWidgets,
      falttendedWidgets.map((widgets: any) => widgets.widgetId),
    );
    // assuming only widgets with same parent can be selected
    const parentId = widgets[selectedWidgets[0]].parentId;
    resizeCanvasToLowestWidget(finalWidgets, parentId);

    yield put(updateAndSaveLayout(finalWidgets));
    yield put(selectWidgetInitAction(""));
    const bulkDeleteKey = selectedWidgets.join(",");
    const saveStatus: boolean = yield saveDeletedWidgets(
      falttendedWidgets,
      bulkDeleteKey,
    );
    if (saveStatus && !disallowUndo) {
      // close property pane after delete
      yield put(closePropertyPane());
      yield put(closeTableFilterPane());
      Toaster.show({
        text: createMessage(WIDGET_BULK_DELETE, `${selectedWidgets.length}`),
        hideProgressBar: false,
        variant: Variant.success,
        dispatchableAction: {
          type: ReduxActionTypes.UNDO_DELETE_WIDGET,
          payload: {
            widgetId: bulkDeleteKey,
          },
        },
      });
      setTimeout(() => {
        if (bulkDeleteKey) {
          flushDeletedWidgets(bulkDeleteKey);
          falttendedWidgets.map((widget: any) => {
            AppsmithConsole.info({
              logType: LOG_TYPE.ENTITY_DELETED,
              text: "Widget was deleted",
              source: {
                name: widget.widgetName,
                type: ENTITY_TYPE.WIDGET,
                id: widget.widgetId,
              },
              analytics: {
                widgetType: widget.type,
              },
            });
          });
        }
      }, WIDGET_DELETE_UNDO_TIMEOUT);
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.WIDGET_OPERATION_ERROR,
      payload: {
        action: WidgetReduxActionTypes.WIDGET_DELETE,
        error,
      },
    });
  }
}

export function* deleteSagaInit(deleteAction: ReduxAction<WidgetDelete>) {
  const { widgetId } = deleteAction.payload;
  const selectedWidget = yield select(getSelectedWidget);
  const selectedWidgets: string[] = yield select(getSelectedWidgets);
  if (selectedWidgets.length > 1) {
    yield put({
      type: WidgetReduxActionTypes.WIDGET_BULK_DELETE,
      payload: deleteAction.payload,
    });
  }
  if (!!widgetId || !!selectedWidget) {
    yield put({
      type: WidgetReduxActionTypes.WIDGET_SINGLE_DELETE,
      payload: deleteAction.payload,
    });
  }
}

export function* deleteSaga(deleteAction: ReduxAction<WidgetDelete>) {
  try {
    let { parentId, widgetId } = deleteAction.payload;
    const { disallowUndo, isShortcut } = deleteAction.payload;

    if (!widgetId) {
      const selectedWidget: FlattenedWidgetProps | undefined = yield select(
        getSelectedWidget,
      );
      if (!selectedWidget) return;

      // if widget is not deletable, don't don anything
      if (selectedWidget.isDeletable === false) return false;

      widgetId = selectedWidget.widgetId;
      parentId = selectedWidget.parentId;
    }

    if (widgetId && parentId) {
      const stateWidgets = yield select(getWidgets);
      const widgets = { ...stateWidgets };
      const stateWidget: WidgetProps = yield select(getWidget, widgetId);
      const widget = { ...stateWidget };

      const stateParent: FlattenedWidgetProps = yield select(
        getWidget,
        parentId,
      );
      let parent = { ...stateParent };

      const analyticsEvent = isShortcut
        ? "WIDGET_DELETE_VIA_SHORTCUT"
        : "WIDGET_DELETE";

      AnalyticsUtil.logEvent(analyticsEvent, {
        widgetName: widget.widgetName,
        widgetType: widget.type,
      });

      // Remove entry from parent's children

      if (parent.children) {
        parent = {
          ...parent,
          children: parent.children.filter((c) => c !== widgetId),
        };
      }

      widgets[parentId] = parent;

      const otherWidgetsToDelete = getAllWidgetsInTree(widgetId, widgets);
      const saveStatus: boolean = yield saveDeletedWidgets(
        otherWidgetsToDelete,
        widgetId,
      );
      let widgetName = widget.widgetName;
      // SPECIAL HANDLING FOR TABS IN A TABS WIDGET
      if (parent.type === WidgetTypes.TABS_WIDGET && widget.tabName) {
        widgetName = widget.tabName;
      }
      if (saveStatus && !disallowUndo) {
        // close property pane after delete
        yield put(closePropertyPane());
        Toaster.show({
          text: createMessage(WIDGET_DELETE, widgetName),
          hideProgressBar: false,
          variant: Variant.success,
          dispatchableAction: {
            type: ReduxActionTypes.UNDO_DELETE_WIDGET,
            payload: {
              widgetId,
            },
          },
        });

        setTimeout(() => {
          if (widgetId) {
            flushDeletedWidgets(widgetId);
            otherWidgetsToDelete.map((widget) => {
              AppsmithConsole.info({
                logType: LOG_TYPE.ENTITY_DELETED,
                text: "Widget was deleted",
                source: {
                  name: widget.widgetName,
                  type: ENTITY_TYPE.WIDGET,
                  id: widget.widgetId,
                },
                analytics: {
                  widgetType: widget.type,
                },
              });
            });
          }
        }, WIDGET_DELETE_UNDO_TIMEOUT);
      }

      yield call(clearEvalPropertyCacheOfWidget, widgetName);

      let finalWidgets: CanvasWidgetsReduxState = yield call(
        updateListWidgetPropertiesOnChildDelete,
        widgets,
        widgetId,
        widgetName,
      );

      finalWidgets = _.omit(
        finalWidgets,
        otherWidgetsToDelete.map((widgets) => widgets.widgetId),
      );

      // Note: mutates finalWidgets
      resizeCanvasToLowestWidget(finalWidgets, parentId);

      yield put(updateAndSaveLayout(finalWidgets));
    }
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.WIDGET_OPERATION_ERROR,
      payload: {
        action: WidgetReduxActionTypes.WIDGET_DELETE,
        error,
      },
    });
  }
}

/**
 * this saga clears out the enhancementMap, template and dynamicBindingPathList when a child
 * is deleted in list widget
 *
 * @param widgets
 * @param widgetId
 * @param widgetName
 * @param parentId
 */
export function* updateListWidgetPropertiesOnChildDelete(
  widgets: CanvasWidgetsReduxState,
  widgetId: string,
  widgetName: string,
) {
  const clone = JSON.parse(JSON.stringify(widgets));

  const parentWithEnhancementFn = getParentWithEnhancementFn(widgetId, clone);

  if (parentWithEnhancementFn?.type === "LIST_WIDGET") {
    const listWidget = parentWithEnhancementFn;

    // delete widget in template of list
    if (listWidget && widgetName in listWidget.template) {
      listWidget.template[widgetName] = undefined;
    }

    // delete dynamic binding path if any
    remove(listWidget?.dynamicBindingPathList || [], (path: any) =>
      path.key.startsWith(`template.${widgetName}`),
    );

    return clone;
  }

  return clone;
}

export function* undoDeleteSaga(action: ReduxAction<{ widgetId: string }>) {
  // Get the list of widget and its children which were deleted
  const deletedWidgets: FlattenedWidgetProps[] = yield getDeletedWidgets(
    action.payload.widgetId,
  );
  const stateWidgets = yield select(getWidgets);
  const deletedWidgetIds = action.payload.widgetId.split(",");
  if (
    deletedWidgets &&
    Array.isArray(deletedWidgets) &&
    deletedWidgets.length
  ) {
    // Get the current list of widgets from reducer
    const formTree = deletedWidgets.reduce((widgetTree, each) => {
      widgetTree[each.widgetId] = each;
      return widgetTree;
    }, {} as CanvasWidgetsReduxState);
    const deletedWidgetGroups = deletedWidgetIds.map((each) => ({
      widget: formTree[each],
      widgetsToRestore: getAllWidgetsInTree(each, formTree),
    }));
    const finalWidgets = deletedWidgetGroups.reduce(
      (reducedWidgets, deletedWidgetGroup) => {
        const {
          widget: deletedWidget,
          widgetsToRestore: deletedWidgets,
        } = deletedWidgetGroup;
        let widgets = cloneDeep(reducedWidgets);

        // If the deleted widget is in fact available.
        if (deletedWidget) {
          // Log an undo event
          AnalyticsUtil.logEvent("WIDGET_DELETE_UNDO", {
            widgetName: deletedWidget.widgetName,
            widgetType: deletedWidget.type,
          });
        }

        // For each deleted widget
        deletedWidgets.forEach((widget: FlattenedWidgetProps) => {
          // Add it to the widgets list we fetched from reducer
          widgets[widget.widgetId] = widget;
          // If the widget in question is the deleted widget
          if (deletedWidgetIds.includes(widget.widgetId)) {
            //SPECIAL HANDLING FOR TAB IN A TABS WIDGET
            if (
              widget.tabId &&
              widget.type === WidgetTypes.CANVAS_WIDGET &&
              widget.parentId &&
              widgets[widget.parentId]
            ) {
              const parent = cloneDeep(widgets[widget.parentId]);
              if (parent.tabsObj) {
                try {
                  parent.tabsObj[widget.tabId] = {
                    id: widget.tabId,
                    widgetId: widget.widgetId,
                    label: widget.tabName || widget.widgetName,
                    isVisible: true,
                  };
                  widgets = {
                    ...widgets,
                    [widget.parentId]: {
                      ...widgets[widget.parentId],
                      tabsObj: parent.tabsObj,
                    },
                  };
                } catch (error) {
                  log.debug("Error deleting tabs widget: ", { error });
                }
              } else {
                parent.tabs = JSON.stringify([
                  {
                    id: widget.tabId,
                    widgetId: widget.widgetId,
                    label: widget.tabName || widget.widgetName,
                  },
                ]);
                widgets = {
                  ...widgets,
                  [widget.parentId]: parent,
                };
              }
            }
            let newChildren = [widget.widgetId];
            if (widget.parentId && widgets[widget.parentId]) {
              if (widgets[widget.parentId].children) {
                // Concatenate the list of parents children with the current widgetId
                newChildren = newChildren.concat(
                  widgets[widget.parentId].children,
                );
              }
              widgets = {
                ...widgets,
                [widget.parentId]: {
                  ...widgets[widget.parentId],
                  children: newChildren,
                },
              };
            }
          }
        });
        return widgets;
      },
      stateWidgets,
    );
    const parentId = deletedWidgets[0].parentId;
    if (parentId) {
      resizeCanvasToLowestWidget(finalWidgets, parentId);
    }
    yield put(updateAndSaveLayout(finalWidgets));
    flashElementsById(deletedWidgetIds, 100);
    yield put(selectMultipleWidgetsInitAction(deletedWidgetIds));
    if (deletedWidgetIds.length === 1) {
      yield put(forceOpenPropertyPane(action.payload.widgetId));
    }
    yield flushDeletedWidgets(action.payload.widgetId);
  }
}

export function* resizeSaga(resizeAction: ReduxAction<WidgetResize>) {
  try {
    Toaster.clear();
    const start = performance.now();
    const {
      bottomRow,
      leftColumn,
      parentId,
      rightColumn,
      topRow,
      widgetId,
    } = resizeAction.payload;

    const stateWidget: FlattenedWidgetProps = yield select(getWidget, widgetId);
    let widget = { ...stateWidget };
    const stateWidgets = yield select(getWidgets);
    const widgets = { ...stateWidgets };

    widget = { ...widget, leftColumn, rightColumn, topRow, bottomRow };
    widgets[widgetId] = widget;
    const updatedCanvasBottomRow: number = yield call(
      updateCanvasSizeAfterWidgetMove,
      parentId,
      bottomRow,
    );
    if (updatedCanvasBottomRow) {
      const canvasWidget = widgets[parentId];
      widgets[parentId] = {
        ...canvasWidget,
        bottomRow: updatedCanvasBottomRow,
      };
    }
    log.debug("resize computations took", performance.now() - start, "ms");
    yield put(updateAndSaveLayout(widgets));
  } catch (error) {
    yield put({
      type: ReduxActionErrorTypes.WIDGET_OPERATION_ERROR,
      payload: {
        action: WidgetReduxActionTypes.WIDGET_RESIZE,
        error,
      },
    });
  }
}

enum DynamicPathUpdateEffectEnum {
  ADD = "ADD",
  REMOVE = "REMOVE",
  NOOP = "NOOP",
}

type DynamicPathUpdate = {
  propertyPath: string;
  effect: DynamicPathUpdateEffectEnum;
};

function getDynamicTriggerPathListUpdate(
  widget: WidgetProps,
  propertyPath: string,
  propertyValue: string,
): DynamicPathUpdate {
  if (propertyValue && !isPathADynamicTrigger(widget, propertyPath)) {
    return {
      propertyPath,
      effect: DynamicPathUpdateEffectEnum.ADD,
    };
  } else if (!propertyValue && !isPathADynamicTrigger(widget, propertyPath)) {
    return {
      propertyPath,
      effect: DynamicPathUpdateEffectEnum.REMOVE,
    };
  }
  return {
    propertyPath,
    effect: DynamicPathUpdateEffectEnum.NOOP,
  };
}

function getDynamicBindingPathListUpdate(
  widget: WidgetProps,
  propertyPath: string,
  propertyValue: any,
): DynamicPathUpdate {
  let stringProp = propertyValue;
  if (_.isObject(propertyValue)) {
    // Stringify this because composite controls may have bindings in the sub controls
    stringProp = JSON.stringify(propertyValue);
  }

  //TODO(abhinav): This is not appropriate from the platform's archtecture's point of view.
  // Figure out a holistic solutions where we donot have to stringify above.
  if (propertyPath === "primaryColumns" || propertyPath === "derivedColumns") {
    return {
      propertyPath,
      effect: DynamicPathUpdateEffectEnum.NOOP,
    };
  }

  const isDynamic = isDynamicValue(stringProp);
  if (!isDynamic && isPathADynamicBinding(widget, propertyPath)) {
    return {
      propertyPath,
      effect: DynamicPathUpdateEffectEnum.REMOVE,
    };
  } else if (isDynamic && !isPathADynamicBinding(widget, propertyPath)) {
    return {
      propertyPath,
      effect: DynamicPathUpdateEffectEnum.ADD,
    };
  }
  return {
    propertyPath,
    effect: DynamicPathUpdateEffectEnum.NOOP,
  };
}

function applyDynamicPathUpdates(
  currentList: DynamicPath[],
  update: DynamicPathUpdate,
): DynamicPath[] {
  if (update.effect === DynamicPathUpdateEffectEnum.ADD) {
    currentList.push({
      key: update.propertyPath,
    });
  } else if (update.effect === DynamicPathUpdateEffectEnum.REMOVE) {
    currentList = _.reject(currentList, { key: update.propertyPath });
  }
  return currentList;
}

const isPropertyATriggerPath = (
  widget: WidgetProps,
  propertyPath: string,
): boolean => {
  const widgetConfig = WidgetFactory.getWidgetPropertyPaneConfig(widget.type);
  const { triggerPaths } = getAllPathsFromPropertyConfig(
    widget,
    widgetConfig,
    {},
  );
  return propertyPath in triggerPaths;
};

function* updateWidgetPropertySaga(
  updateAction: ReduxAction<UpdateWidgetPropertyRequestPayload>,
) {
  const {
    payload: { propertyPath, propertyValue, widgetId },
  } = updateAction;

  // Holder object to collect all updates
  const updates: Record<string, unknown> = {
    [propertyPath]: propertyValue,
  };
  // Push these updates via the batch update
  yield call(
    batchUpdateWidgetPropertySaga,
    batchUpdateWidgetProperty(widgetId, { modify: updates }),
  );
}

function* setWidgetDynamicPropertySaga(
  action: ReduxAction<SetWidgetDynamicPropertyPayload>,
) {
  const { isDynamic, propertyPath, widgetId } = action.payload;
  const stateWidget: WidgetProps = yield select(getWidget, widgetId);
  let widget = cloneDeep({ ...stateWidget });
  const propertyValue = _.get(widget, propertyPath);

  let dynamicPropertyPathList = getWidgetDynamicPropertyPathList(widget);
  if (isDynamic) {
    const keyExists =
      dynamicPropertyPathList.findIndex((path) => path.key === propertyPath) >
      -1;
    if (!keyExists) {
      dynamicPropertyPathList.push({
        key: propertyPath,
      });
    }
    widget = set(widget, propertyPath, convertToString(propertyValue));
  } else {
    dynamicPropertyPathList = _.reject(dynamicPropertyPathList, {
      key: propertyPath,
    });
    const { parsed } = yield call(
      validateProperty,
      propertyPath,
      propertyValue,
      widget,
    );
    widget = set(widget, propertyPath, parsed);
  }
  widget.dynamicPropertyPathList = dynamicPropertyPathList;

  const stateWidgets = yield select(getWidgets);
  const widgets = { ...stateWidgets, [widgetId]: widget };

  // Save the layout
  yield put(updateAndSaveLayout(widgets));
}

function getPropertiesToUpdate(
  widget: WidgetProps,
  updates: Record<string, unknown>,
  triggerPaths?: string[],
): {
  propertyUpdates: Record<string, unknown>;
  dynamicTriggerPathList: DynamicPath[];
  dynamicBindingPathList: DynamicPath[];
} {
  // Create a
  const widgetWithUpdates = _.cloneDeep(widget);
  Object.entries(updates).forEach(([propertyPath, propertyValue]) => {
    set(widgetWithUpdates, propertyPath, propertyValue);
  });

  // get the flat list of all updates (in case values are objects)
  const updatePaths = getAllPaths(updates);

  const propertyUpdates: Record<string, unknown> = {
    ...updates,
  };
  const currentDynamicTriggerPathList: DynamicPath[] = getWidgetDynamicTriggerPathList(
    widget,
  );
  const currentDynamicBindingPathList: DynamicPath[] = getEntityDynamicBindingPathList(
    widget,
  );
  const dynamicTriggerPathListUpdates: DynamicPathUpdate[] = [];
  const dynamicBindingPathListUpdates: DynamicPathUpdate[] = [];

  Object.keys(updatePaths).forEach((propertyPath) => {
    const propertyValue = _.get(updates, propertyPath);
    // only check if
    if (!_.isString(propertyValue)) {
      return;
    }

    // Check if the path is a of a dynamic trigger property
    let isTriggerProperty = isPropertyATriggerPath(
      widgetWithUpdates,
      propertyPath,
    );

    isTriggerProperty = doesTriggerPathsContainPropertyPath(
      isTriggerProperty,
      propertyPath,
      triggerPaths,
    );

    // If it is a trigger property, it will go in a different list than the general
    // dynamicBindingPathList.
    if (isTriggerProperty) {
      dynamicTriggerPathListUpdates.push(
        getDynamicTriggerPathListUpdate(widget, propertyPath, propertyValue),
      );
    } else {
      dynamicBindingPathListUpdates.push(
        getDynamicBindingPathListUpdate(widget, propertyPath, propertyValue),
      );
    }
  });

  const dynamicTriggerPathList = dynamicTriggerPathListUpdates.reduce(
    applyDynamicPathUpdates,
    currentDynamicTriggerPathList,
  );
  const dynamicBindingPathList = dynamicBindingPathListUpdates.reduce(
    applyDynamicPathUpdates,
    currentDynamicBindingPathList,
  );

  return {
    propertyUpdates,
    dynamicTriggerPathList,
    dynamicBindingPathList,
  };
}

function* getPropertiesUpdatedWidget(updatesObj: UpdateWidgetPropertyPayload) {
  const { updates, widgetId } = updatesObj;

  const { modify = {}, remove = [], triggerPaths } = updates;

  const stateWidget: WidgetProps = yield select(getWidget, widgetId);

  // if there is no widget in the state, don't do anything
  if (!stateWidget) return;

  let widget = cloneDeep(stateWidget);
  try {
    if (Object.keys(modify).length > 0) {
      const {
        dynamicBindingPathList,
        dynamicTriggerPathList,
        propertyUpdates,
      } = getPropertiesToUpdate(widget, modify, triggerPaths);

      // We loop over all updates
      Object.entries(propertyUpdates).forEach(
        ([propertyPath, propertyValue]) => {
          // since property paths could be nested, we use lodash set method
          widget = set(widget, propertyPath, propertyValue);
        },
      );
      widget.dynamicBindingPathList = dynamicBindingPathList;
      widget.dynamicTriggerPathList = dynamicTriggerPathList;
    }
  } catch (e) {
    log.debug("Error updating property paths: ", { e });
  }

  if (Array.isArray(remove) && remove.length > 0) {
    widget = yield removeWidgetProperties(widget, remove);
  }
  return widget;
}

function* batchUpdateWidgetPropertySaga(
  action: ReduxAction<UpdateWidgetPropertyPayload>,
) {
  const start = performance.now();
  const { widgetId } = action.payload;
  if (!widgetId) {
    // Handling the case where sometimes widget id is not passed through here
    return;
  }
  const updatedWidget: WidgetProps = yield call(
    getPropertiesUpdatedWidget,
    action.payload,
  );
  const stateWidgets = yield select(getWidgets);
  const widgets = { ...stateWidgets, [widgetId]: updatedWidget };
  log.debug(
    "Batch widget property update calculations took: ",
    performance.now() - start,
    "ms",
  );

  // Save the layout
  yield put(updateAndSaveLayout(widgets));
}

function* batchUpdateMultipleWidgetsPropertiesSaga(
  action: ReduxAction<{ updatesArray: UpdateWidgetPropertyPayload[] }>,
) {
  const start = performance.now();
  const { updatesArray } = action.payload;
  const stateWidgets = yield select(getWidgets);
  const updatedWidgets: WidgetProps[] = yield all(
    updatesArray.map((eachUpdate) => {
      return call(getPropertiesUpdatedWidget, eachUpdate);
    }),
  );
  const updatedStateWidgets = updatedWidgets.reduce(
    (allWidgets, eachUpdatedWidget) => {
      return {
        ...allWidgets,
        [eachUpdatedWidget.widgetId]: eachUpdatedWidget,
      };
    },
    stateWidgets,
  );

  log.debug(
    "Batch widget property update calculations took: ",
    performance.now() - start,
    "ms",
  );

  // Save the layout
  yield put(updateAndSaveLayout(updatedStateWidgets));
}

function* removeWidgetProperties(widget: WidgetProps, paths: string[]) {
  try {
    let dynamicTriggerPathList: DynamicPath[] = getWidgetDynamicTriggerPathList(
      widget,
    );
    let dynamicBindingPathList: DynamicPath[] = getEntityDynamicBindingPathList(
      widget,
    );
    let dynamicPropertyPathList: DynamicPath[] = getWidgetDynamicPropertyPathList(
      widget,
    );

    paths.forEach((propertyPath) => {
      dynamicTriggerPathList = dynamicTriggerPathList.filter((dynamicPath) => {
        return !isChildPropertyPath(propertyPath, dynamicPath.key);
      });

      dynamicBindingPathList = dynamicBindingPathList.filter((dynamicPath) => {
        return !isChildPropertyPath(propertyPath, dynamicPath.key);
      });

      dynamicPropertyPathList = dynamicPropertyPathList.filter(
        (dynamicPath) => {
          return !isChildPropertyPath(propertyPath, dynamicPath.key);
        },
      );
    });

    widget.dynamicBindingPathList = dynamicBindingPathList;
    widget.dynamicTriggerPathList = dynamicTriggerPathList;
    widget.dynamicPropertyPathList = dynamicPropertyPathList;

    paths.forEach((propertyPath) => {
      widget = unsetPropertyPath(widget, propertyPath) as WidgetProps;
    });
  } catch (e) {
    log.debug("Error removing propertyPaths: ", { e });
  }

  return widget;
}

function* deleteWidgetPropertySaga(
  action: ReduxAction<DeleteWidgetPropertyPayload>,
) {
  const { propertyPaths, widgetId } = action.payload;
  if (!widgetId) {
    // Handling the case where sometimes widget id is not passed through here
    return;
  }

  yield put(batchUpdateWidgetProperty(widgetId, { remove: propertyPaths }));
}

//TODO(abhinav): Move this to helpers and add tests
const unsetPropertyPath = (obj: Record<string, unknown>, path: string) => {
  const regex = /(.*)\[\d+\]$/;
  if (regex.test(path)) {
    const matches = path.match(regex);
    if (
      matches &&
      Array.isArray(matches) &&
      matches[1] &&
      matches[1].length > 0
    ) {
      _.unset(obj, path);
      const arr = _.get(obj, matches[1]);
      if (arr && Array.isArray(arr)) {
        _.set(obj, matches[1], arr.filter(Boolean));
      }
    }
  } else {
    _.unset(obj, path);
  }
  return obj;
};

function* resetChildrenMetaSaga(action: ReduxAction<{ widgetId: string }>) {
  const parentWidgetId = action.payload.widgetId;
  const canvasWidgets: CanvasWidgetsReduxState = yield select(getWidgets);
  const childrenIds: string[] = getWidgetChildren(
    canvasWidgets,
    parentWidgetId,
  );
  for (const childIndex in childrenIds) {
    const childId = childrenIds[childIndex];
    yield put(resetWidgetMetaProperty(childId));
  }
}

function* updateCanvasSize(
  action: ReduxAction<{ canvasWidgetId: string; snapRows: number }>,
) {
  const { canvasWidgetId, snapRows } = action.payload;
  const canvasWidget = yield select(getWidget, canvasWidgetId);

  const originalSnapRows = canvasWidget.bottomRow - canvasWidget.topRow;

  const newBottomRow = Math.round(
    snapRows * GridDefaults.DEFAULT_GRID_ROW_HEIGHT,
  );
  /* Update the canvas's rows, ONLY if it has changed since the last render */
  if (originalSnapRows !== newBottomRow) {
    // TODO(abhinav): This considers that the topRow will always be zero
    // Check this out when non canvas widgets are updating snapRows
    // erstwhile: Math.round((rows * props.snapRowSpace) / props.parentRowSpace),
    yield put(
      batchUpdateWidgetProperty(canvasWidgetId, {
        modify: { bottomRow: newBottomRow },
      }),
    );
  }
}

function* createSelectedWidgetsCopy(selectedWidgets: FlattenedWidgetProps[]) {
  if (!selectedWidgets || !selectedWidgets.length) return;
  const widgetListsToStore: {
    widgetId: string;
    parentId: string;
    list: FlattenedWidgetProps[];
  }[] = yield all(selectedWidgets.map((each) => call(createWidgetCopy, each)));

  return yield saveCopiedWidgets(JSON.stringify(widgetListsToStore));
}

/**
 * copy here actually means saving a JSON in local storage
 * so when a user hits copy on a selected widget, we save widget in localStorage
 *
 * @param action
 * @returns
 */
function* copyWidgetSaga(action: ReduxAction<{ isShortcut: boolean }>) {
  const allWidgets: { [widgetId: string]: FlattenedWidgetProps } = yield select(
    getWidgets,
  );
  const selectedWidgets: string[] = yield select(getSelectedWidgets);
  if (!selectedWidgets) {
    Toaster.show({
      text: createMessage(ERROR_WIDGET_COPY_NO_WIDGET_SELECTED),
      variant: Variant.info,
    });
    return;
  }

  const allAllowedToCopy = selectedWidgets.some((each) => {
    return allWidgets[each] && !allWidgets[each].disallowCopy;
  });

  if (!allAllowedToCopy) {
    Toaster.show({
      text: createMessage(ERROR_WIDGET_COPY_NOT_ALLOWED),
      variant: Variant.info,
    });

    return;
  }
  const selectedWidgetProps = selectedWidgets.map((each) => allWidgets[each]);

  const saveResult = yield createSelectedWidgetsCopy(selectedWidgetProps);

  selectedWidgetProps.forEach((each) => {
    const eventName = action.payload.isShortcut
      ? "WIDGET_COPY_VIA_SHORTCUT"
      : "WIDGET_COPY";
    AnalyticsUtil.logEvent(eventName, {
      widgetName: each.widgetName,
      widgetType: each.type,
    });
  });

  if (saveResult) {
    Toaster.show({
      text: createMessage(
        WIDGET_COPY,
        selectedWidgetProps.length > 1
          ? `${selectedWidgetProps.length} Widgets`
          : selectedWidgetProps[0].widgetName,
      ),
      variant: Variant.success,
    });
  }
}

/**
 *  We take the bottom most widget in the canvas, then calculate the top,left,right,bottom
 *  co-ordinates for the new widget, such that it can be placed at the bottom of the canvas.
 *
 * @param widget
 * @param parentId
 * @param canvasWidgets
 * @param parentBottomRow
 * @param persistColumnPosition
 * @returns
 */
export function calculateNewWidgetPosition(
  widget: WidgetProps,
  parentId: string,
  canvasWidgets: { [widgetId: string]: FlattenedWidgetProps },
  parentBottomRow?: number,
  shouldPersistColumnPosition = false,
  isThereACollision = false,
  shouldGroup = false,
): {
  topRow: number;
  bottomRow: number;
  leftColumn: number;
  rightColumn: number;
} {
  const nextAvailableRow = parentBottomRow
    ? parentBottomRow
    : nextAvailableRowInContainer(parentId, canvasWidgets);
  return {
    leftColumn: shouldPersistColumnPosition ? widget.leftColumn : 0,
    rightColumn: shouldPersistColumnPosition
      ? widget.rightColumn
      : widget.rightColumn - widget.leftColumn,
    topRow:
      !isThereACollision && shouldGroup
        ? widget.topRow
        : parentBottomRow
        ? nextAvailableRow + widget.topRow
        : nextAvailableRow,
    bottomRow:
      !isThereACollision && shouldGroup
        ? widget.bottomRow
        : parentBottomRow
        ? nextAvailableRow + widget.bottomRow
        : nextAvailableRow + (widget.bottomRow - widget.topRow),
  };
}

/**
 * this saga create a new widget from the copied one to store
 */
function* pasteWidgetSaga(action: ReduxAction<{ groupWidgets: boolean }>) {
  let copiedWidgetGroups: CopiedWidgetGroup[] = yield getCopiedWidgets();
  const shouldGroup: boolean = action.payload.groupWidgets;

  const newlyCreatedWidgetIds: string[] = [];
  const evalTree: DataTree = yield select(getDataTree);
  const canvasWidgets: CanvasWidgetsReduxState = yield select(getWidgets);
  let widgets: CanvasWidgetsReduxState = canvasWidgets;
  const selectedWidget: FlattenedWidgetProps<undefined> = yield getSelectedWidgetWhenPasting();

  const pastingIntoWidgetId: string = yield getParentWidgetIdForPasting(
    canvasWidgets,
    selectedWidget,
  );

  let isThereACollision: boolean = yield isSelectedWidgetsColliding(
    widgets,
    copiedWidgetGroups,
    pastingIntoWidgetId,
  );

  // if this is true, selected widgets will be grouped in container
  if (shouldGroup) {
    copiedWidgetGroups = yield createSelectedWidgetsAsCopiedWidgets();
    widgets = yield filterOutSelectedWidgets(
      copiedWidgetGroups[0].parentId,
      copiedWidgetGroups,
    );
    isThereACollision = yield isSelectedWidgetsColliding(
      widgets,
      copiedWidgetGroups,
      pastingIntoWidgetId,
    );

    copiedWidgetGroups = yield groupWidgetsIntoContainer(
      copiedWidgetGroups,
      pastingIntoWidgetId,
    );
  }

  // to avoid invoking old copied widgets
  if (!Array.isArray(copiedWidgetGroups)) return;

  const { topMostWidget } = getBoundaryWidgetsFromCopiedGroups(
    copiedWidgetGroups,
  );
  const nextAvailableRow: number = nextAvailableRowInContainer(
    pastingIntoWidgetId,
    widgets,
  );

  yield all(
    copiedWidgetGroups.map((copiedWidgets) =>
      call(function*() {
        // Don't try to paste if there is no copied widget
        if (!copiedWidgets) return;

        const copiedWidgetId = copiedWidgets.widgetId;
        const unUpdatedCopyOfWidget = copiedWidgets.list[0];
        const newTopRow = shouldGroup
          ? isThereACollision
            ? topMostWidget.topRow
            : 0
          : topMostWidget.topRow;

        const copiedWidget = {
          ...unUpdatedCopyOfWidget,
          topRow: unUpdatedCopyOfWidget.topRow - newTopRow,
          bottomRow: unUpdatedCopyOfWidget.bottomRow - newTopRow,
        };

        // Log the paste or group event.
        if (shouldGroup) {
          AnalyticsUtil.logEvent("WIDGET_GROUP", {
            widgetName: copiedWidget.widgetName,
            widgetType: copiedWidget.type,
          });
        } else {
          AnalyticsUtil.logEvent("WIDGET_PASTE", {
            widgetName: copiedWidget.widgetName,
            widgetType: copiedWidget.type,
          });
        }

        // Compute the new widget's positional properties
        const newWidgetPosition = calculateNewWidgetPosition(
          copiedWidget,
          pastingIntoWidgetId,
          widgets,
          nextAvailableRow,
          true,
          isThereACollision,
          shouldGroup,
        );

        // Get a flat list of all the widgets to be updated
        const widgetList = copiedWidgets.list;
        const widgetIdMap: Record<string, string> = {};
        const widgetNameMap: Record<string, string> = {};
        const newWidgetList: FlattenedWidgetProps[] = [];
        // Generate new widgetIds for the flat list of all the widgets to be updated

        widgetList.forEach((widget) => {
          // Create a copy of the widget properties
          const newWidget = cloneDeep(widget);
          newWidget.widgetId = generateReactKey();
          // Add the new widget id so that it maps the previous widget id
          widgetIdMap[widget.widgetId] = newWidget.widgetId;

          // Add the new widget to the list
          newWidgetList.push(newWidget);
        });

        // For each of the new widgets generated
        for (let i = 0; i < newWidgetList.length; i++) {
          const widget = newWidgetList[i];
          const oldWidgetName = widget.widgetName;
          let newWidgetName = oldWidgetName;

          if (!shouldGroup) {
            newWidgetName = getNextWidgetName(widgets, widget.type, evalTree, {
              prefix: oldWidgetName,
              startWithoutIndex: true,
            });
          }

          // Update the children widgetIds if it has children
          if (widget.children && widget.children.length > 0) {
            widget.children.forEach((childWidgetId: string, index: number) => {
              if (widget.children) {
                widget.children[index] = widgetIdMap[childWidgetId];
              }
            });
          }

          // Update the tabs for the tabs widget.
          if (widget.tabsObj && widget.type === WidgetTypes.TABS_WIDGET) {
            try {
              const tabs = Object.values(widget.tabsObj);
              if (Array.isArray(tabs)) {
                widget.tabsObj = tabs.reduce((obj: any, tab) => {
                  tab.widgetId = widgetIdMap[tab.widgetId];
                  obj[tab.id] = tab;
                  return obj;
                }, {});
              }
            } catch (error) {
              log.debug("Error updating tabs", error);
            }
          }

          // Update the table widget column properties
          if (widget.type === WidgetTypes.TABLE_WIDGET) {
            try {
              // If the primaryColumns of the table exist
              if (widget.primaryColumns) {
                // For each column
                for (const [columnId, column] of Object.entries(
                  widget.primaryColumns,
                )) {
                  // For each property in the column
                  for (const [key, value] of Object.entries(
                    column as ColumnProperties,
                  )) {
                    // Replace reference of previous widget with the new widgetName
                    // This handles binding scenarios like `{{Table2.tableData.map((currentRow) => (currentRow.id))}}`
                    widget.primaryColumns[columnId][key] = isString(value)
                      ? value.replace(`${oldWidgetName}.`, `${newWidgetName}.`)
                      : value;
                  }
                }
              }
              // Use the new widget name we used to replace the column properties above.
              widget.widgetName = newWidgetName;
            } catch (error) {
              log.debug("Error updating table widget properties", error);
            }
          }

          // If it is the copied widget, update position properties
          if (widget.widgetId === widgetIdMap[copiedWidget.widgetId]) {
            const {
              bottomRow,
              leftColumn,
              rightColumn,
              topRow,
            } = newWidgetPosition;
            widget.leftColumn = leftColumn;
            widget.topRow = topRow;
            widget.bottomRow = bottomRow;
            widget.rightColumn = rightColumn;
            widget.parentId = pastingIntoWidgetId;
            // Also, update the parent widget in the canvas widgets
            // to include this new copied widget's id in the parent's children
            let parentChildren = [widget.widgetId];
            const widgetChildren = widgets[pastingIntoWidgetId].children;
            if (widgetChildren && Array.isArray(widgetChildren)) {
              // Add the new child to existing children
              parentChildren = parentChildren.concat(widgetChildren);
            }
            const parentBottomRow = getParentBottomRowAfterAddingWidget(
              widgets[pastingIntoWidgetId],
              widget,
            );

            widgets = {
              ...widgets,
              [pastingIntoWidgetId]: {
                ...widgets[pastingIntoWidgetId],
                bottomRow: parentBottomRow,
                children: parentChildren,
              },
            };
            // If the copied widget's boundaries exceed the parent's
            // Make the parent scrollable
            if (
              widgets[pastingIntoWidgetId].bottomRow *
                widgets[widget.parentId].parentRowSpace <=
              widget.bottomRow * widget.parentRowSpace
            ) {
              const parentOfPastingWidget =
                widgets[pastingIntoWidgetId].parentId;
              if (
                parentOfPastingWidget &&
                widget.parentId !== MAIN_CONTAINER_WIDGET_ID
              ) {
                const parent = widgets[parentOfPastingWidget];
                widgets[parentOfPastingWidget] = {
                  ...parent,
                  shouldScrollContents: true,
                };
              }
            }
          } else {
            // For all other widgets in the list
            // (These widgets will be descendants of the copied widget)
            // This means, that their parents will also be newly copied widgets
            // Update widget's parent widget ids with the new parent widget ids
            const newParentId = newWidgetList.find((newWidget) =>
              widget.parentId
                ? newWidget.widgetId === widgetIdMap[widget.parentId]
                : false,
            )?.widgetId;
            if (newParentId) widget.parentId = newParentId;
          }
          // Generate a new unique widget name
          if (!shouldGroup) {
            widget.widgetName = newWidgetName;
          }

          widgetNameMap[oldWidgetName] = widget.widgetName;
          // Add the new widget to the canvas widgets
          widgets[widget.widgetId] = widget;
        }
        newlyCreatedWidgetIds.push(widgetIdMap[copiedWidgetId]);
        // 1. updating template in the copied widget and deleting old template associations
        // 2. updating dynamicBindingPathList in the copied grid widget
        for (let i = 0; i < newWidgetList.length; i++) {
          const widget = newWidgetList[i];

          widgets = handleSpecificCasesWhilePasting(
            widget,
            widgets,
            widgetNameMap,
            newWidgetList,
          );
        }
      }),
    ),
  );

  yield put(updateAndSaveLayout(widgets));

  flashElementsById(newlyCreatedWidgetIds, 100);

  yield put(selectMultipleWidgetsInitAction(newlyCreatedWidgetIds));
}

function* cutWidgetSaga() {
  const allWidgets: { [widgetId: string]: FlattenedWidgetProps } = yield select(
    getWidgets,
  );
  const selectedWidgets: string[] = yield select(getSelectedWidgets);
  if (!selectedWidgets) {
    Toaster.show({
      text: createMessage(ERROR_WIDGET_CUT_NO_WIDGET_SELECTED),
      variant: Variant.info,
    });
    return;
  }

  const selectedWidgetProps = selectedWidgets.map((each) => allWidgets[each]);

  const saveResult = yield createSelectedWidgetsCopy(selectedWidgetProps);

  selectedWidgetProps.forEach((each) => {
    const eventName = "WIDGET_CUT_VIA_SHORTCUT"; // cut only supported through a shortcut
    AnalyticsUtil.logEvent(eventName, {
      widgetName: each.widgetName,
      widgetType: each.type,
    });
  });

  if (saveResult) {
    Toaster.show({
      text: createMessage(
        WIDGET_CUT,
        selectedWidgetProps.length > 1
          ? `${selectedWidgetProps.length} Widgets`
          : selectedWidgetProps[0].widgetName,
      ),
      variant: Variant.success,
    });
  }

  yield put({
    type: WidgetReduxActionTypes.WIDGET_DELETE,
    payload: {
      disallowUndo: true,
      isShortcut: true,
    },
  });
}

function* addSuggestedWidget(action: ReduxAction<Partial<WidgetProps>>) {
  const widgetConfig = action.payload;

  if (!widgetConfig.type) return;

  const defaultConfig = WidgetConfigResponse.config[widgetConfig.type];
  const evalTree = yield select(getDataTree);
  const widgets = yield select(getWidgets);

  const widgetName = getNextWidgetName(widgets, widgetConfig.type, evalTree);

  try {
    let newWidget = {
      newWidgetId: generateReactKey(),
      widgetId: "0",
      parentId: "0",
      renderMode: RenderModes.CANVAS,
      isLoading: false,
      ...defaultConfig,
      widgetName,
      ...widgetConfig,
    };

    const {
      bottomRow,
      leftColumn,
      rightColumn,
      topRow,
    } = yield calculateNewWidgetPosition(
      newWidget as WidgetProps,
      MAIN_CONTAINER_WIDGET_ID,
      widgets,
    );

    newWidget = {
      ...newWidget,
      leftColumn,
      topRow,
      rightColumn,
      bottomRow,
      parentRowSpace: GridDefaults.DEFAULT_GRID_ROW_HEIGHT,
    };

    yield put({
      type: WidgetReduxActionTypes.WIDGET_ADD_CHILD,
      payload: newWidget,
    });

    const applicationId = yield select(getCurrentApplicationId);
    const pageId = yield select(getCurrentPageId);

    navigateToCanvas(
      {
        applicationId,
        pageId,
      },
      window.location.pathname,
      pageId,
      newWidget.newWidgetId,
    );
    yield put(forceOpenPropertyPane(newWidget.newWidgetId));
  } catch (error) {
    log.error(error);
  }
}

/**
 * saga to group selected widgets into a new container
 *
 * @param action
 */
export function* groupWidgetsSaga() {
  const selectedWidgetIDs: string[] = yield select(getSelectedWidgets);
  const isMultipleWidgetsSelected = selectedWidgetIDs.length > 1;

  if (isMultipleWidgetsSelected) {
    try {
      yield put({
        type: ReduxActionTypes.PASTE_COPIED_WIDGET_INIT,
        payload: {
          groupWidgets: true,
        },
      });
    } catch (error) {
      log.error(error);
    }
  }
}

export default function* widgetOperationSagas() {
  yield fork(widgetSelectionSagas);
  yield fork(widgetAdditionSagas);
  yield all([
    takeEvery(ReduxActionTypes.ADD_SUGGESTED_WIDGET, addSuggestedWidget),
    takeEvery(WidgetReduxActionTypes.WIDGET_DELETE, deleteSagaInit),
    takeEvery(WidgetReduxActionTypes.WIDGET_SINGLE_DELETE, deleteSaga),
    takeEvery(
      WidgetReduxActionTypes.WIDGET_BULK_DELETE,
      deleteAllSelectedWidgetsSaga,
    ),

    takeLatest(WidgetReduxActionTypes.WIDGET_RESIZE, resizeSaga),
    takeEvery(
      ReduxActionTypes.UPDATE_WIDGET_PROPERTY_REQUEST,
      updateWidgetPropertySaga,
    ),
    takeEvery(
      WidgetReduxActionTypes.WIDGET_UPDATE_PROPERTY,
      updateWidgetPropertySaga,
    ),
    takeEvery(
      ReduxActionTypes.SET_WIDGET_DYNAMIC_PROPERTY,
      setWidgetDynamicPropertySaga,
    ),
    takeEvery(
      ReduxActionTypes.RESET_CHILDREN_WIDGET_META,
      resetChildrenMetaSaga,
    ),
    takeEvery(
      ReduxActionTypes.BATCH_UPDATE_WIDGET_PROPERTY,
      batchUpdateWidgetPropertySaga,
    ),
    takeEvery(
      ReduxActionTypes.BATCH_UPDATE_MULTIPLE_WIDGETS_PROPERTY,
      batchUpdateMultipleWidgetsPropertiesSaga,
    ),
    takeEvery(
      ReduxActionTypes.DELETE_WIDGET_PROPERTY,
      deleteWidgetPropertySaga,
    ),
    takeLatest(ReduxActionTypes.UPDATE_CANVAS_SIZE, updateCanvasSize),
    takeLatest(ReduxActionTypes.COPY_SELECTED_WIDGET_INIT, copyWidgetSaga),
    takeEvery(ReduxActionTypes.PASTE_COPIED_WIDGET_INIT, pasteWidgetSaga),
    takeEvery(ReduxActionTypes.UNDO_DELETE_WIDGET, undoDeleteSaga),
    takeEvery(ReduxActionTypes.CUT_SELECTED_WIDGET, cutWidgetSaga),
    takeEvery(ReduxActionTypes.GROUP_WIDGETS_INIT, groupWidgetsSaga),
  ]);
}
