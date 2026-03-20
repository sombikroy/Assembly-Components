sap.ui.define([
    "jquery.sap.global",
    "sap/dm/dme/podfoundation/controller/PluginViewController",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
    "sap/m/MessageBox"
], function (jQuery, PluginViewController, JSONModel, Filter, FilterOperator, MessageToast, MessageBox) {
    "use strict";

    return PluginViewController.extend("sb.custom.plugins.assemblycomponent.controller.MainView", {

        onInit: function () {
            PluginViewController.prototype.onInit.apply(this, arguments);

            var oModel = new JSONModel({
                components:     [],
                totalCount:     0,
                assembledCount: 0,
                pendingCount:   0,
                backflushCount: 0,
                sfcValue:       "",
                plantValue:     "",
                busy:           false,
                lastRefreshed:  ""
            });
            this.getView().setModel(oModel, "vm");

            // Subscribe to phaseSelectionEvent so data reloads whenever
            // the operator selects a phase/operation in the POD
            this.subscribe("phaseSelectionEvent", this._onPhaseSelected, this);
        },

        onAfterRendering: function () {
            var oConfig = this.getConfiguration();
            this.getView().byId("backButton").setVisible(!!oConfig.backButtonVisible);
            this.getView().byId("closeButton").setVisible(!!oConfig.closeButtonVisible);
            this.getView().byId("headerTitle").setText(oConfig.title || "Planned Components");
        },

        onBeforeRenderingPlugin: function () {
            this._loadPlannedComponents();
        },

        _onPhaseSelected: function (sChannelId, sEventId, oData) {
            this._loadPlannedComponents();
        },

        // ─────────────────────────────────────────────────────────────
        //  Step 1 — fetch plannedComponents
        // ─────────────────────────────────────────────────────────────
        _loadPlannedComponents: function () {
            var oModel = this.getView().getModel("vm");
            var sPlant = this._getPlant();
            var sSfc   = this._getSfc();

            oModel.setProperty("/plantValue", sPlant || "");
            oModel.setProperty("/sfcValue",   sSfc   || "");

            if (!sPlant || !sSfc) {
                this._clearTable(oModel);
                return;
            }

            oModel.setProperty("/busy", true);

            var sBase = this._getBaseUrl();
            var sUrl  = sBase + "/assembly/v1/plannedComponents"
                + "?plant=" + encodeURIComponent(sPlant)
                + "&sfc="   + encodeURIComponent(sSfc);

            jQuery.ajax({
                url:      sUrl,
                method:   "GET",
                dataType: "json",
                success:  function (aData) {
                    this._loadBomAndFilter(oModel, aData, sPlant, sBase);
                }.bind(this),
                error: this._onDataError.bind(this, oModel)
            });
        },

        // ─────────────────────────────────────────────────────────────
        //  Step 2 — derive BOM key from plannedComponents response,
        //           fetch BOM, build BULK set, then filter
        // ─────────────────────────────────────────────────────────────
        _loadBomAndFilter: function (oModel, aPlannedComponents, sPlant, sBase) {

            // Order number and material come directly from the POD selection model
            var sOrderNumber = this._getOrderNumber();
            var sMaterial    = this._getMaterial();

            if (!sOrderNumber || !sMaterial) {
                // Cannot build BOM key — show all components unfiltered
                this._applyComponents(oModel, aPlannedComponents, { bulkSet: {}, backflushMap: {} });
                return;
            }

            // BOM key pattern: <orderNumber>-<material>-1-1
            var sBom    = sOrderNumber + "-" + sMaterial + "-1-1";
            var sBomUrl = sBase + "/bom/v1/boms"
                + "?bom="                    + encodeURIComponent(sBom)
                + "&plant="                  + encodeURIComponent(sPlant)
                + "&type=SHOP_ORDER"
                + "&readReservationsAndBatch=true";

            jQuery.ajax({
                url:      sBomUrl,
                method:   "GET",
                dataType: "json",
                success: function (aBomData) {
                    var oResult = this._buildBulkSet(aBomData);
                    this._applyComponents(oModel, aPlannedComponents, oResult);
                }.bind(this),
                error: function (oXHR) {
                    // BOM call failed — show all components without filtering
                    var sMsg = (oXHR.responseJSON && oXHR.responseJSON.message)
                        ? oXHR.responseJSON.message : oXHR.statusText;
                    jQuery.sap.log.warning("BOM call failed, showing all components: " + sMsg);
                    this._applyComponents(oModel, aPlannedComponents, { bulkSet: {}, backflushMap: {} });
                }.bind(this)
            });
        },

        // ─────────────────────────────────────────────────────────────
        //  Derive order number from the operationActivity field
        //  Format: "1990744-0-0020"  →  "1990744"
        // ─────────────────────────────────────────────────────────────
        _deriveOrderFromPlanned: function (aPlannedComponents) {
            if (!Array.isArray(aPlannedComponents) || aPlannedComponents.length === 0) {
                return null;
            }
            var sOA = aPlannedComponents[0].operationActivity;
            if (!sOA) { return null; }
            // Split on "-0-" to isolate the order number prefix
            var iPivot = sOA.indexOf("-0-");
            if (iPivot > 0) {
                return sOA.substring(0, iPivot);
            }
            // Fallback: take everything before the last two dash-segments
            var aParts = sOA.split("-");
            if (aParts.length >= 3) {
                return aParts.slice(0, aParts.length - 2).join("-");
            }
            return null;
        },

        // ─────────────────────────────────────────────────────────────
        //  Build lookup { materialNumber: true } for all BULK components
        //  BULK is identified by customValues: [{ attribute:"BULK", value:"true" }]
        //  Also builds a backflush map { materialNumber: true/false }
        // ─────────────────────────────────────────────────────────────
        _buildBulkSet: function (aBomData) {
            var oBulkSet      = {};
            var oBackflushMap = {};
            if (!Array.isArray(aBomData)) { return { bulkSet: oBulkSet, backflushMap: oBackflushMap }; }

            aBomData.forEach(function (oBom) {
                if (!Array.isArray(oBom.components)) { return; }
                oBom.components.forEach(function (oComp) {
                    var sMaterial = oComp.material && oComp.material.material;
                    if (!sMaterial) { return; }

                    // Track backflush flag, storage location, reservation numbers and warehouse number
                    oBackflushMap[sMaterial] = {
                        backflushEnabled:       !!oComp.backflushEnabled,
                        storageLocation:        oComp.storageLocation        || "",
                        reservationOrderNumber: oComp.reservationOrderNumber || "",
                        reservationItemNumber:  oComp.reservationItemNumber  || "",
                        warehouseNumber:        oComp.warehouseNumber        || ""
                    };

                    // Track BULK flag
                    var bIsBulk = Array.isArray(oComp.customValues) &&
                        oComp.customValues.some(function (cv) {
                            return cv.attribute === "BULK" && cv.value === "true";
                        });
                    if (bIsBulk) {
                        oBulkSet[sMaterial] = true;
                    }
                });
            });
            return { bulkSet: oBulkSet, backflushMap: oBackflushMap };
        },

        // ─────────────────────────────────────────────────────────────
        //  Remove BULK components and update the table model
        // ─────────────────────────────────────────────────────────────
        _applyComponents: function (oModel, aAll, oResult) {
            var oBulkSet      = oResult.bulkSet      || oResult; // backward compat if plain object passed
            var oBackflushMap = oResult.backflushMap || {};

            var aFiltered  = aAll.filter(function (o) { return !oBulkSet[o.component]; });

            // Enrich each planned component with backflushEnabled, storageLocation, reservation numbers and warehouseNumber from the BOM
            aFiltered.forEach(function (o) {
                if (oBackflushMap.hasOwnProperty(o.component)) {
                    o.backflushEnabled       = oBackflushMap[o.component].backflushEnabled;
                    o.storageLocation        = oBackflushMap[o.component].storageLocation;
                    o.reservationOrderNumber = oBackflushMap[o.component].reservationOrderNumber;
                    o.reservationItemNumber  = oBackflushMap[o.component].reservationItemNumber;
                    o.warehouseNumber        = oBackflushMap[o.component].warehouseNumber;
                } else {
                    o.backflushEnabled       = false;
                    o.storageLocation        = "";
                    o.reservationOrderNumber = "";
                    o.reservationItemNumber  = "";
                    o.warehouseNumber        = "";
                }
            });

            var nAssembled  = aFiltered.filter(function (o) { return o.remainingQuantity <= 0; }).length;
            var nBackflush  = aFiltered.filter(function (o) { return o.backflushEnabled === true; }).length;

            oModel.setProperty("/components",     aFiltered);
            oModel.setProperty("/totalCount",     aFiltered.length);
            oModel.setProperty("/assembledCount", nAssembled);
            oModel.setProperty("/pendingCount",   aFiltered.length - nAssembled);
            oModel.setProperty("/backflushCount", nBackflush);
            oModel.setProperty("/lastRefreshed",  new Date().toLocaleTimeString());
            oModel.setProperty("/busy",           false);
        },

        _clearTable: function (oModel) {
            oModel.setProperty("/components",     []);
            oModel.setProperty("/totalCount",     0);
            oModel.setProperty("/assembledCount", 0);
            oModel.setProperty("/pendingCount",   0);
            oModel.setProperty("/backflushCount", 0);
        },

        _onDataError: function (oModel, oXHR) {
            oModel.setProperty("/busy", false);
            var sMsg = (oXHR.responseJSON && oXHR.responseJSON.message)
                ? oXHR.responseJSON.message : oXHR.statusText;
            MessageBox.error("Failed to load planned components:\n" + sMsg);
        },

        // ─────────────────────────────────────────────────────────────
        //  POD context helpers
        // ─────────────────────────────────────────────────────────────
        _getBaseUrl: function () {
            try {
                if (typeof this.getPublicApiRestDataSourceUri === "function") {
                    return this.getPublicApiRestDataSourceUri() || "";
                }
            } catch (e) { /* ignore */ }
            return "";
        },

        _getPlant: function () {
            try {
                return this.getPodController().getUserPlant();
            } catch (e) { /* ignore */ }
            var oC = this.getConfiguration();
            return (oC && oC.plant) ? oC.plant : null;
        },

        _getSelection: function () {
            // Returns first selection object from POD selection model.
            // Known structure: { sfc, sfcData: { material, routing }, shopOrder: { shopOrder } }
            try {
                var aSel = this.getPodController().getPodSelectionModel().getSelections();
                if (aSel && aSel.length > 0) { return aSel[0]; }
            } catch (e) { /* ignore */ }
            return null;
        },

        _getSfc: function () {
            var oSel = this._getSelection();
            return (oSel && oSel.sfc) ? oSel.sfc : null;
        },

        _getMaterial: function () {
            var oSel = this._getSelection();
            return (oSel && oSel.sfcData && oSel.sfcData.material) ? oSel.sfcData.material : null;
        },

        _getOrderNumber: function () {
            var oSel = this._getSelection();
            return (oSel && oSel.shopOrder && oSel.shopOrder.shopOrder) ? oSel.shopOrder.shopOrder : null;
        },


        // ─────────────────────────────────────────────────────────────
        //  UI event handlers
        // ─────────────────────────────────────────────────────────────
        onRefreshPress: function () {
            MessageToast.show("Refreshing...");
            this._loadPlannedComponents();
        },

        onSearchLive: function (oEvent) {
            this._applySearch(oEvent.getParameter("newValue") || "");
        },

        onSearch: function (oEvent) {
            this._applySearch(oEvent.getParameter("query") || "");
        },

        _applySearch: function (sVal) {
            var oBinding = this.getView().byId("componentsTable").getBinding("items");
            if (!oBinding) { return; }
            if (!sVal) { oBinding.filter([]); return; }
            oBinding.filter(new Filter({
                filters: [
                    new Filter("component",            FilterOperator.Contains, sVal),
                    new Filter("componentDescription", FilterOperator.Contains, sVal),
                    new Filter("stepId",               FilterOperator.Contains, sVal)
                ],
                and: false
            }));
        },

        onStatusFilter: function (oEvent) {
            var sKey     = oEvent.getParameter("selectedItem").getKey();
            var oBinding = this.getView().byId("componentsTable").getBinding("items");
            if (!oBinding) { return; }

            var oFilter = null;
            if      (sKey === "PENDING")  { oFilter = new Filter("remainingQuantity", FilterOperator.GT, 0); }
            else if (sKey === "CONSUMED") { oFilter = new Filter("remainingQuantity", FilterOperator.LE, 0); }

            oBinding.filter(oFilter ? [oFilter] : []);
        },

        onBackflushFilter: function (oEvent) {
            var sKey     = oEvent.getParameter("selectedItem").getKey();
            var oBinding = this.getView().byId("componentsTable").getBinding("items");
            if (!oBinding) { return; }

            var oFilter = null;
            if      (sKey === "YES") { oFilter = new Filter("backflushEnabled", FilterOperator.EQ, true); }
            else if (sKey === "NO")  { oFilter = new Filter("backflushEnabled", FilterOperator.EQ, false); }

            oBinding.filter(oFilter ? [oFilter] : []);
        },

        // ─────────────────────────────────────────────────────────────
        //  Formatters
        // ─────────────────────────────────────────────────────────────
        fmtRowHighlight: function (fRem) {
            return fRem <= 0 ? "Success" : "Warning";
        },

        fmtStatusState: function (fRem) {
            return fRem <= 0 ? "Success" : "Warning";
        },

        fmtStatusText: function (fAssembled, fRequired) {
            if (fAssembled >= fRequired) { return "Consumed"; }
            if (fAssembled > 0)          { return "Partial";  }
            return "Pending";
        },

        fmtStatusIcon: function (fRem) {
            return fRem <= 0 ? "sap-icon://accept" : "sap-icon://alert";
        },

        fmtBackflushText: function (bEnabled) {
            return bEnabled ? "Yes" : "No";
        },

        fmtBackflushState: function (bEnabled) {
            return bEnabled ? "Information" : "None";
        },

        fmtBackflushIcon: function (bEnabled) {
            return bEnabled ? "sap-icon://synchronize" : "sap-icon://cancel";
        },

        // ─────────────────────────────────────────────────────────────
        //  Notification stubs
        // ─────────────────────────────────────────────────────────────
        isSubscribingToNotifications:  function () { return false; },
        getCustomNotificationEvents:   function () { return []; },
        getNotificationMessageHandler: function () { return null; },

        onExit: function () {
            PluginViewController.prototype.onExit.apply(this, arguments);
        }
    });
});